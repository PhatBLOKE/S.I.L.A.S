using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

namespace HavocConsole
{
    static class Program
    {
        private const string HealthUrl = "http://127.0.0.1:8000/api/system";
        private const string AppUrl = "http://localhost:8000";

        [STAThread]
        static void Main()
        {
            try
            {
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                Directory.SetCurrentDirectory(baseDir);

                // 1. Check if server is already running
                if (!IsServerHealthy())
                {
                    // 2. Start Python server in background
                    StartBackendServer(baseDir);

                    // 3. Wait for health check up to 6 seconds
                    int retries = 20;
                    while (retries-- > 0 && !IsServerHealthy())
                    {
                        Thread.Sleep(300);
                    }
                }

                // 4. Open App Window
                LaunchAppWindow();
            }
            catch (Exception ex)
            {
                MessageBox.Show("Failed to launch Silas Console:\n" + ex.Message, 
                    "Silas Launcher Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static bool IsServerHealthy()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(HealthUrl);
                req.Timeout = 800;
                using (var resp = (HttpWebResponse)req.GetResponse())
                {
                    return resp.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        private static void StartBackendServer(string workingDir)
        {
            string pythonExe = "python.exe";

            // Fallback check for user's specific python installation
            string localPython = @"C:\Users\PhatBLOKE\AppData\Local\Python\pythoncore-3.14-64\python.exe";
            if (File.Exists(localPython))
            {
                pythonExe = localPython;
            }

            var psi = new ProcessStartInfo
            {
                FileName = pythonExe,
                Arguments = "-m uvicorn backend.app:app --host 0.0.0.0 --port 8000",
                WorkingDirectory = workingDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };

            Process.Start(psi);
        }

        private static void LaunchAppWindow()
        {
            try
            {
                // Launch Edge in standalone Application Mode (frameless HUD app)
                var psi = new ProcessStartInfo
                {
                    FileName = "msedge.exe",
                    Arguments = string.Format("--app={0} --window-name=HavocConsole", AppUrl),
                    UseShellExecute = true
                };
                Process.Start(psi);
            }
            catch
            {
                // Fallback to default browser
                Process.Start(new ProcessStartInfo
                {
                    FileName = AppUrl,
                    UseShellExecute = true
                });
            }
        }
    }
}
