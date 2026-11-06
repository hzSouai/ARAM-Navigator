using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Principal;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("LOL 大乱斗助手")]
[assembly: AssemblyDescription("大乱斗/海克斯大乱斗备选席助手启动器")]
[assembly: AssemblyProduct("LOL 大乱斗助手")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

internal static class Program
{
    private const int DefaultPort = 8765;

    [STAThread]
    private static void Main()
    {
        try
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            string script = Path.Combine(baseDir, "src", "index.js");
            if (!File.Exists(script))
            {
                MessageBox.Show(
                    "找不到 src\\index.js。\n请把本程序放在 LOL 大乱斗助手目录里运行喵。",
                    "LOL 大乱斗助手",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return;
            }

            int port = ReadWebPort(baseDir);
            string url = "http://127.0.0.1:" + port + "/";

            if (PortOpen(port))
            {
                OpenBrowser(url);
                return;
            }

            // Only ask for UAC when we actually need to start the helper.
            // The League client is elevated, so the Node process must be too.
            if (!IsAdministrator())
            {
                try
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = Process.GetCurrentProcess().MainModule.FileName,
                        UseShellExecute = true,
                        Verb = "runas",
                        WorkingDirectory = baseDir,
                    });
                }
                catch (System.ComponentModel.Win32Exception)
                {
                    // The user cancelled the UAC prompt.
                }
                return;
            }

            string node = FindNode();
            if (node == null)
            {
                MessageBox.Show(
                    "没有找到 Node.js 20+。\n请先安装 Node.js 后再试喵。",
                    "LOL 大乱斗助手",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return;
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = node,
                Arguments = "\"" + script + "\" --web",
                WorkingDirectory = baseDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
            };
            Process.Start(startInfo);

            for (int i = 0; i < 40; i++)
            {
                if (PortOpen(port))
                {
                    OpenBrowser(url);
                    return;
                }
                Thread.Sleep(250);
            }

            MessageBox.Show(
                "助手启动超时了喵。\n请查看 logs 目录里的日志，或以管理员身份运行一次看报错。",
                "LOL 大乱斗助手",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
        catch (Exception error)
        {
            MessageBox.Show(
                "启动失败喵：\n" + error.Message,
                "LOL 大乱斗助手",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    private static int ReadWebPort(string baseDir)
    {
        try
        {
            string configPath = Path.Combine(baseDir, "config.json");
            if (File.Exists(configPath))
            {
                string text = File.ReadAllText(configPath);
                Match match = Regex.Match(text, "\"webPort\"\\s*:\\s*(\\d+)");
                int port;
                if (match.Success && int.TryParse(match.Groups[1].Value, out port) &&
                    port > 0 && port < 65536)
                {
                    return port;
                }
            }
        }
        catch
        {
            // Fall back to the default port.
        }
        return DefaultPort;
    }

    private static bool IsAdministrator()
    {
        try
        {
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
            {
                var principal = new WindowsPrincipal(identity);
                return principal.IsInRole(WindowsBuiltInRole.Administrator);
            }
        }
        catch
        {
            return false;
        }
    }

    private static bool PortOpen(int port)
    {
        try
        {
            using (var client = new TcpClient())
            {
                var task = client.ConnectAsync("127.0.0.1", port);
                return task.Wait(300) && client.Connected;
            }
        }
        catch
        {
            return false;
        }
    }

    private static string FindNode()
    {
        string[] candidates =
        {
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                "nodejs",
                "node.exe"),
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                "nodejs",
                "node.exe"),
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                "nodejs",
                "node.exe"),
        };

        foreach (string candidate in candidates)
        {
            if (!string.IsNullOrEmpty(candidate) && File.Exists(candidate))
            {
                return candidate;
            }
        }

        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string directory in path.Split(Path.PathSeparator))
        {
            try
            {
                string candidate = Path.Combine(directory.Trim(), "node.exe");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
            catch
            {
                // Ignore malformed PATH entries.
            }
        }
        return null;
    }

    private static void OpenBrowser(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = url,
                UseShellExecute = true,
            });
        }
        catch
        {
            // The page can still be opened manually.
        }
    }
}
