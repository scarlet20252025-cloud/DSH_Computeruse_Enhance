# 聚焦诊断：WPF TextBox 的 UIA ValuePattern 在缓存视图下到底怎么读才拿得到值。
#
# 背景：真机端到端发现 `get_app_state` 对 WPF TextBox 返回 `value=""`，
# 但同一控件里确实有文本（ctrl+a/ctrl+c 能复制出来）。缓存视图下的 pattern 读取
# 有几种写法，这里逐个测，确定唯一可靠的那个。
#
# 输出：stdout 一组 `RESULT <name> = <value>` 行。
# 约束：Windows PowerShell 5.1 + STA；文件须带 UTF-8 BOM。
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="CUA cache probe" Width="420" Height="160"
        WindowStartupLocation="Manual" Left="200" Top="200">
  <TextBox x:Name="ProbeBox" AutomationProperties.Name="ProbeBox" Text="hello-value-42"/>
</Window>
'@

$window = [System.Windows.Markup.XamlReader]::Parse($xaml)

$window.Add_ContentRendered({
  Start-Sleep -Milliseconds 300
  $ae = [System.Windows.Automation.AutomationElement]
  $root = $ae::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition($ae::NameProperty, 'ProbeBox')
  $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if ($null -eq $el) { [Console]::Out.WriteLine('RESULT found = false'); [Console]::Out.Flush(); $window.Close(); return }
  [Console]::Out.WriteLine('RESULT found = true')

  $vp = [System.Windows.Automation.ValuePattern]

  # 1) 未缓存：Current
  try {
    $p = $el.GetCurrentPattern($vp::Pattern)
    [Console]::Out.WriteLine("RESULT current_getpattern = '$($p.Current.Value)'")
  } catch { [Console]::Out.WriteLine("RESULT current_getpattern = ERROR $($_.Exception.Message)") }

  # 2) 未缓存：TryGetCurrentPattern
  try {
    $obj = $null
    if ($el.TryGetCurrentPattern($vp::Pattern, [ref]$obj)) {
      [Console]::Out.WriteLine("RESULT current_trygetpattern = '$($obj.Current.Value)'")
    } else { [Console]::Out.WriteLine('RESULT current_trygetpattern = FALSE') }
  } catch { [Console]::Out.WriteLine("RESULT current_trygetpattern = ERROR $($_.Exception.Message)") }

  # 3) 未缓存：GetCurrentPropertyValue(ValueProperty)
  try {
    [Console]::Out.WriteLine("RESULT current_property = '$($el.GetCurrentPropertyValue($vp::ValueProperty))'")
  } catch { [Console]::Out.WriteLine("RESULT current_property = ERROR $($_.Exception.Message)") }

  # 4) 缓存视图：Add(Pattern) 后 TryGetCachedPattern → .Cached / .Current
  $cache = New-Object System.Windows.Automation.CacheRequest
  $cache.Add($vp::Pattern)
  $cache.Add($vp::ValueProperty)
  $cache.TreeScope = [System.Windows.Automation.TreeScope]::Element
  $act = $null
  try {
    $act = $cache.Activate()
    $cond2 = New-Object System.Windows.Automation.PropertyCondition($ae::NameProperty, 'ProbeBox')
    $cel = $ae::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond2)
    [Console]::Out.WriteLine("RESULT cached_el_found = $($null -ne $cel)")

    $obj = $null
    $ok = $false
    try { $ok = $cel.TryGetCachedPattern($vp::Pattern, [ref]$obj) } catch { [Console]::Out.WriteLine("RESULT cached_tryget = ERROR $($_.Exception.Message)") }
    [Console]::Out.WriteLine("RESULT cached_trygetpattern = $ok")
    if ($ok) {
      try { [Console]::Out.WriteLine("RESULT cached_pattern_cached_value = '$($obj.Cached.Value)'") } catch { [Console]::Out.WriteLine("RESULT cached_pattern_cached_value = ERROR $($_.Exception.Message)") }
      try { [Console]::Out.WriteLine("RESULT cached_pattern_current_value = '$($obj.Current.Value)'") } catch { [Console]::Out.WriteLine("RESULT cached_pattern_current_value = ERROR $($_.Exception.Message)") }
    }
    try { [Console]::Out.WriteLine("RESULT cached_propertyvalue = '$($cel.GetCachedPropertyValue($vp::ValueProperty))'") } catch { [Console]::Out.WriteLine("RESULT cached_propertyvalue = ERROR $($_.Exception.Message)") }
    try { [Console]::Out.WriteLine("RESULT cached_propertyvalue_ignored = '$($cel.GetCachedPropertyValue($vp::ValueProperty, $true))'") } catch { [Console]::Out.WriteLine("RESULT cached_propertyvalue_ignored = ERROR $($_.Exception.Message)") }
  } catch {
    [Console]::Out.WriteLine("RESULT cache_block = ERROR $($_.Exception.Message)")
  } finally {
    if ($null -ne $act) { try { $act.Dispose() } catch { } }
  }

  [Console]::Out.Flush()
  $window.Close()
})

[void]$window.ShowDialog()
