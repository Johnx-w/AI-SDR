$ErrorActionPreference = 'Stop'

Write-Host '设置 ShadeFlow 公网入口密码（用户名：root；与服务器 root 登录无关）'
Write-Host '请输入 6–72 位 ASCII 可见字符。输入时不会显示。'

$first = Read-Host '新密码' -AsSecureString
$second = Read-Host '再次输入' -AsSecureString

function Read-Secret([securestring]$value) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($value)
  try {
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

try {
  $password = Read-Secret $first
  $confirmation = Read-Secret $second
  if ($password -cne $confirmation) { throw '两次输入不一致，请重新运行脚本。' }
  if ($password -cnotmatch '^[!-~]{6,72}$') { throw '密码须为 6–72 位 ASCII 可见字符，请重新运行脚本。' }

  $ssh = [Diagnostics.Process]::new()
  $ssh.StartInfo.FileName = 'ssh.exe'
  $ssh.StartInfo.Arguments = '-o BatchMode=yes -o ConnectTimeout=8 ai-sdr "umask 027; htpasswd -iB -c /etc/nginx/shadeflow.htpasswd root && chown root:www-data /etc/nginx/shadeflow.htpasswd && chmod 640 /etc/nginx/shadeflow.htpasswd"'
  $ssh.StartInfo.UseShellExecute = $false
  $ssh.StartInfo.RedirectStandardInput = $true
  if (-not $ssh.Start()) { throw '无法启动 SSH。' }
  $ssh.StandardInput.Write($password + "`n")
  $ssh.StandardInput.Close()
  $ssh.WaitForExit()
  if ($ssh.ExitCode -ne 0) { throw '服务器未接受密码更新；请检查 SSH 连接后重试。' }
  Write-Host '密码哈希已写入服务器。请关闭本窗口。'
} finally {
  $password = $null
  $confirmation = $null
  $first.Dispose()
  $second.Dispose()
}
