# 端到端测试夹具：一个只有我们自己的 WPF 窗口，供 tools/e2e.mjs 注入输入。
#
# 为什么不用记事本：用户可能正开着记事本（Win11 下多窗口可能同进程），
# 关窗口/杀进程会伤到用户文档。这个夹具窗口的属主进程是我们自己启动的，
# 关掉它零风险；而且它的可观察状态是确定的：
#   - TextBox：支持 UIA ValuePattern → set_value / type 都能写、都能回读 value
#   - Button：支持 InvokePattern → perform_action(invoke) 与点击都能改窗口标题
#     （标题改成 "DSH CUA Fixture CLICKED:<n>"，用 get_app_state 读标题即证据）
#
# 为什么用 WPF 而不是 WinForms：实测 Windows PowerShell 5.1 宿主下 WinForms 控件
# 在 UIA 里只是一堆无名 `Pane`（TextBlock/TextBox/Button 全无 ValuePattern/InvokePattern），
# 连 `set_value` 都无法验证；WPF 的 UIA 支持是完整的（Edit + Value、Button + Invoke）。
#
# 输出：stdout 一行握手 `FIXTURE_PID=<pid>`（随后进消息循环，直到被 kill）。
# 约束：Windows PowerShell 5.1 兼容、需要 STA（调用方传 -STA）；文件须带 UTF-8 BOM。
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="DSH CUA Fixture" Width="520" Height="240"
        WindowStartupLocation="Manual" Left="120" Top="120" Topmost="True"
        ResizeMode="NoResize">
  <Grid Margin="16">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
    </Grid.RowDefinitions>
    <TextBlock Grid.Row="0" Text="CUA fixture — safe target for input injection"/>
    <TextBox Grid.Row="1" x:Name="FixtureInput" Height="28" Margin="0,12,0,0"
             AutomationProperties.Name="FixtureInput"/>
    <Button Grid.Row="2" x:Name="FixtureButton" Content="Press Me" Width="160"
            HorizontalAlignment="Left" Margin="0,16,0,0"
            AutomationProperties.Name="FixtureButton"/>
  </Grid>
</Window>
'@

$window = [System.Windows.Markup.XamlReader]::Parse($xaml)
$box = $window.FindName('FixtureInput')
$button = $window.FindName('FixtureButton')

$script:clickCount = 0
$button.Add_Click({
  $script:clickCount = $script:clickCount + 1
  $window.Title = "DSH CUA Fixture CLICKED:$($script:clickCount)"
})

$window.Add_ContentRendered({
  $window.Activate()
  $box.Focus()
  [System.Windows.Input.Keyboard]::Focus($box) | Out-Null
})

[Console]::Out.WriteLine("FIXTURE_PID=$PID")
[Console]::Out.Flush()
[void]$window.ShowDialog()
