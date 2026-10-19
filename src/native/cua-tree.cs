using System.Text;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Windows.Automation;

public class CuaNode {
  public int Index;
  public int Depth;
  public string Role = "";
  public string Name = "";
  public string Value = "";
  public string AutomationId = "";
  public string ClassName = "";
  public bool Enabled = true;
  public bool Focused;
  public bool Offscreen;
  public bool Focusable;
  public bool HasRect;
  public int X, Y, W, H;
  public string[] Actions = new string[0];
  public int[] RuntimeId;
}

// UIA 树遍历的 C# 快路径。
// 动机：PS 版同样逻辑实测 400 元素 700~1000ms，其中绝大部分是 PowerShell 的
// 循环/属性绑定开销，而不是 UIA 的跨进程成本（C# 同一逻辑 280~310ms）。
public class CuaTree {
  static readonly AutomationProperty[] Props = new AutomationProperty[] {
    AutomationElement.NameProperty,
    AutomationElement.ControlTypeProperty,
    AutomationElement.AutomationIdProperty,
    AutomationElement.ClassNameProperty,
    AutomationElement.IsEnabledProperty,
    AutomationElement.IsOffscreenProperty,
    AutomationElement.BoundingRectangleProperty,
    AutomationElement.IsKeyboardFocusableProperty,
    AutomationElement.HasKeyboardFocusProperty
  };

  static void AddPattern(CacheRequest c, AutomationPattern p) { try { c.Add(p); } catch { } }

  static void AddDefault(CacheRequest cache) {
    foreach (AutomationProperty p in Props) { try { cache.Add(p); } catch { } }
    AddPattern(cache, InvokePattern.Pattern);
    AddPattern(cache, ExpandCollapsePattern.Pattern);
    AddPattern(cache, TogglePattern.Pattern);
    AddPattern(cache, SelectionItemPattern.Pattern);
    AddPattern(cache, SelectionPattern.Pattern);
    AddPattern(cache, ValuePattern.Pattern);
    AddPattern(cache, TextPattern.Pattern);
    AddPattern(cache, ScrollPattern.Pattern);
    AddPattern(cache, ScrollItemPattern.Pattern);
    cache.TreeScope = TreeScope.Element;
  }

  static string[] ActionsOf(AutomationElement el) {
    List<string> list = new List<string>(4);
    object o;
    o = null; if (el.TryGetCachedPattern(InvokePattern.Pattern, out o)) list.Add("invoke");
    o = null;
    if (el.TryGetCachedPattern(ExpandCollapsePattern.Pattern, out o)) {
      string st = null;
      try { st = ((ExpandCollapsePattern)o).Cached.ExpandCollapseState.ToString(); } catch { }
      if (st == "Expanded") list.Add("collapse");
      else if (st == "Collapsed") list.Add("expand");
      else if (st == "PartiallyExpanded") { list.Add("expand"); list.Add("collapse"); }
      else if (st != "LeafNode") { list.Add("expand"); list.Add("collapse"); }
    }
    o = null; if (el.TryGetCachedPattern(TogglePattern.Pattern, out o)) list.Add("toggle");
    o = null; if (el.TryGetCachedPattern(SelectionItemPattern.Pattern, out o)) list.Add("select");
    o = null;
    if (el.TryGetCachedPattern(ValuePattern.Pattern, out o)) {
      bool ro = false;
      try { ro = ((ValuePattern)o).Cached.IsReadOnly; } catch { }
      if (!ro) list.Add("set_value");
    }
    o = null; if (el.TryGetCachedPattern(TextPattern.Pattern, out o)) list.Add("select_text");
    o = null; if (el.TryGetCachedPattern(ScrollItemPattern.Pattern, out o)) list.Add("scroll");
    return list.ToArray();
  }

  static string ReadValue(AutomationElement el) {
    object o;
    o = null;
    try {
      if (el.TryGetCachedPattern(ValuePattern.Pattern, out o)) {
        string s = ((ValuePattern)o).Cached.Value;
        if (!string.IsNullOrEmpty(s)) return s;
      }
    } catch { }
    o = null;
    try {
      object v = el.GetCachedPropertyValue(ValuePattern.ValueProperty, true);
      string s2 = v as string;
      if (!string.IsNullOrEmpty(s2)) return s2;
    } catch { }
    o = null;
    try {
      if (el.TryGetCurrentPattern(ValuePattern.Pattern, out o)) {
        string s3 = ((ValuePattern)o).Current.Value;
        if (!string.IsNullOrEmpty(s3)) return s3;
      }
    } catch { }
    // 只读文档（只有 TextPattern）的文本通道默认关闭：$_tp.Cached 在 .NET 的
    // TextPattern 上并不存在，所以历史上这一级从未生效；打开它会改变 get_app_state
    // 的 value 语义与体积，属于行为变更，留给单独一轮评估。
    return "";
  }

  static bool HasAction(CuaNode n, string name) {
    if (n.Actions == null) return false;
    for (int i = 0; i < n.Actions.Length; i++) { if (n.Actions[i] == name) return true; }
    return false;
  }

  // 返回值用数组而不是 out 参数，PowerShell 侧再用 [ref] 包，避免 PS 对 out 的绑定陷阱。
  static void SetStat(int[] s, int i, int v) { if (s != null && i >= 0 && i < s.Length) s[i] = v; }


  public static CuaNode[] Walk(AutomationElement root, int maxElements, int maxDepth, int budgetMs, int[] stats) {
    long tFind = 0, tSnap = 0, tAct = 0, tFindOff = 0; int nFindOn = 0, nFindOff = 0;
    // stats: [0]=truncated [1]=walkMs [2]=focusedIndex [3]=error flag
    CacheRequest cache = new CacheRequest();
    AddDefault(cache);
    cache.Push();
    try {
      Stopwatch sw = Stopwatch.StartNew();
      List<CuaNode> outList = new List<CuaNode>(maxElements);
      List<AutomationElement> queueEl = new List<AutomationElement>(maxElements);
      List<int> queueDepth = new List<int>(maxElements);
      queueEl.Add(root);
      queueDepth.Add(0);
      int cursor = 0;
      bool sawOnscreenDoc = false;
      Condition trueCond = Condition.TrueCondition;
      List<AutomationElement> onK = new List<AutomationElement>(16);
      List<AutomationElement> offK = new List<AutomationElement>(16);
      while (cursor < queueEl.Count) {
        if (outList.Count >= maxElements) { SetStat(stats, 0, 1); break; }
        if (sw.ElapsedMilliseconds > budgetMs) { SetStat(stats, 0, 1); break; }
        AutomationElement el = queueEl[cursor];
        int depth = queueDepth[cursor];
        cursor++;
        CuaNode node = new CuaNode();
        node.Index = outList.Count;
        node.Depth = depth;
        long tS0 = Stopwatch.GetTimestamp();
        AutomationElement.AutomationElementInformation ci;
        bool useCurrent = false;
        try {
          object probe = el.GetCachedPropertyValue(AutomationElement.ControlTypeProperty, false);
          if (probe == null) useCurrent = true;
        } catch { useCurrent = true; }
        if (useCurrent) {
          try { ci = el.Current; } catch { continue; }
        } else {
          try { ci = el.Cached; } catch { continue; }
        }
        try { node.Name = ci.Name ?? ""; } catch { }
        try { node.AutomationId = ci.AutomationId ?? ""; } catch { }
        try { node.ClassName = ci.ClassName ?? ""; } catch { }
        try { node.Enabled = ci.IsEnabled; } catch { }
        try { node.Offscreen = ci.IsOffscreen; } catch { }
        try { node.Focusable = ci.IsKeyboardFocusable; } catch { }
        try { node.Focused = ci.HasKeyboardFocus; } catch { }
        try {
          System.Windows.Rect r = ci.BoundingRectangle;
          if (!r.IsEmpty && r.Width > 0 && r.Height > 0) {
            node.HasRect = true;
            node.X = (int)Math.Round(r.X);
            node.Y = (int)Math.Round(r.Y);
            node.W = (int)Math.Round(r.Width);
            node.H = (int)Math.Round(r.Height);
          }
        } catch { }
        try {
          ControlType ct = ci.ControlType;
          if (ct != null) {
            string pn = ct.ProgrammaticName;
            if (pn != null && pn.StartsWith("ControlType.")) pn = pn.Substring(12);
            node.Role = pn ?? "";
          }
        } catch { }
        tSnap += Stopwatch.GetTimestamp() - tS0;
        long tA0 = Stopwatch.GetTimestamp();
        if (!node.Offscreen) {
          try { node.Actions = ActionsOf(el); } catch { }
          try { node.RuntimeId = el.GetRuntimeId(); } catch { }
          if (HasAction(node, "set_value") || HasAction(node, "select_text")) {
            try { node.Value = ReadValue(el); } catch { }
          }
        }
        tAct += Stopwatch.GetTimestamp() - tA0;
        outList.Add(node);
        if (depth >= maxDepth) continue;
        // 跳过「后台标签页」的 Document 子树。
        // 实测（Firefox 9 个标签页里 8 个是后台）：不跳 289 ms / onscreen 66 / 链接 37；
        // 跳过后 202 ms / onscreen 142 / 链接 101 —— 更快且可见内容更多。
        // 判定口径是「已经有可见文档在前」，而不是「这个文档离屏」：
        // 窗口一旦最小化，所有 Document 都会被标成离屏，此时若直接按离屏跳过，
        // 就会把整页正文一起丢掉（最小化读页面是既有能力，不能回退）。
        if (node.Role == "Document") {
          if (!node.Offscreen) sawOnscreenDoc = true;
          else if (sawOnscreenDoc) continue;
        }
        AutomationElementCollection kids = null;
        long tF0 = Stopwatch.GetTimestamp();
        try { kids = el.FindAll(TreeScope.Children, trueCond); } catch { kids = null; }
        long dF = Stopwatch.GetTimestamp() - tF0;
        tFind += dF;
        if (node.Offscreen) { tFindOff += dF; nFindOff++; } else { nFindOn++; }
        if (kids == null) continue;
        onK.Clear();
        offK.Clear();
        foreach (AutomationElement k in kids) {
          bool off = false;
          try { off = k.Cached.IsOffscreen; } catch { }
          if (off) offK.Add(k); else onK.Add(k);
        }
        foreach (AutomationElement k in onK) {
          if (outList.Count + queueEl.Count - cursor >= maxElements) { SetStat(stats, 0, 1); break; }
          queueEl.Add(k);
          queueDepth.Add(depth + 1);
        }
        foreach (AutomationElement k in offK) {
          if (outList.Count + queueEl.Count - cursor >= maxElements) { SetStat(stats, 0, 1); break; }
          queueEl.Add(k);
          queueDepth.Add(depth + 1);
        }
      }
      SetStat(stats, 1, (int)sw.ElapsedMilliseconds);
      SetStat(stats, 4, (int)(tFind * 1000 / Stopwatch.Frequency));
      SetStat(stats, 5, (int)(tSnap * 1000 / Stopwatch.Frequency));
      SetStat(stats, 6, (int)(tAct * 1000 / Stopwatch.Frequency));
      SetStat(stats, 7, (int)(tFindOff * 1000 / Stopwatch.Frequency));
      // focused 元素定位：比较 runtimeId
      SetStat(stats, 2, -1);
      try {
        AutomationElement fe = AutomationElement.FocusedElement;
        if (fe != null) {
          int[] fr = fe.GetRuntimeId();
          AutomationElement feCached = null;
          try { feCached = fe; } catch { }
          if (fr != null) {
            for (int i = 0; i < outList.Count; i++) {
              int[] rid = outList[i].RuntimeId;
              if (rid == null || rid.Length != fr.Length) continue;
              bool same = true;
              for (int j = 0; j < rid.Length; j++) {
                if (rid[j] != fr[j]) { same = false; break; }
              }
              if (same) { SetStat(stats, 2, i); break; }
            }
          }
        }
      } catch { }
      return outList.ToArray();
    } catch (Exception) {
      SetStat(stats, 3, 1);
      return new CuaNode[0];
    } finally {
      try { cache.Pop(); } catch { }
    }
  }
}
