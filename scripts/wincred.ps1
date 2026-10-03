param(
    [Parameter(Mandatory=$true)]
    [string]$Action, # "write" or "read" or "delete"
    [string]$Target = "gemini:antigravity",
    [string]$User = "antigravity",
    [Parameter(ValueFromPipeline=$true)]
    [string]$Secret = ""
)

$definition = @"
using System;
using System.Runtime.InteropServices;

public class WinCredManager {
    [DllImport("Advapi32.dll", SetLastError = true, EntryPoint = "CredWriteW", CharSet = CharSet.Unicode)]
    public static extern bool CredWrite([In] ref CREDENTIAL userCredential, [In] uint flags);

    [DllImport("Advapi32.dll", SetLastError = true, EntryPoint = "CredReadW", CharSet = CharSet.Unicode)]
    public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

    [DllImport("Advapi32.dll", SetLastError = true, EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode)]
    public static extern bool CredDelete(string target, int type, int flags);

    [DllImport("Advapi32.dll", SetLastError = true, EntryPoint = "CredFree")]
    public static extern void CredFree([In] IntPtr buffer);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public long LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    public static bool Write(string target, string user, string secret) {
        CREDENTIAL cred = new CREDENTIAL();
        cred.Type = 1; // Generic
        cred.TargetName = target;
        cred.UserName = user;
        cred.Persist = 2; // LocalMachine

        byte[] bytes = System.Text.Encoding.UTF8.GetBytes(secret);
        cred.CredentialBlobSize = bytes.Length;
        cred.CredentialBlob = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, cred.CredentialBlob, bytes.Length);

        try {
            return CredWrite(ref cred, 0);
        } finally {
            Marshal.FreeHGlobal(cred.CredentialBlob);
        }
    }

    public static string Read(string target) {
        IntPtr ptr;
        if (CredRead(target, 1, 0, out ptr)) {
            try {
                CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
                if (c.CredentialBlobSize > 0 && c.CredentialBlob != IntPtr.Zero) {
                    byte[] bytes = new byte[c.CredentialBlobSize];
                    Marshal.Copy(c.CredentialBlob, bytes, 0, c.CredentialBlobSize);
                    return System.Text.Encoding.UTF8.GetString(bytes);
                }
            } finally {
                CredFree(ptr);
            }
        }
        return null;
    }

    public static bool Delete(string target) {
        return CredDelete(target, 1, 0);
    }
}
"@

if (-not ([System.Management.Automation.PSTypeName]'WinCredManager').Type) {
    Add-Type -TypeDefinition $definition
}

if ($Action -eq "write") {
    # If secret is passed via pipeline or arg
    if (-not $Secret -and $input) {
        $Secret = [string]::Join("`n", $input)
    }
    $res = [WinCredManager]::Write($Target, $User, $Secret)
    if ($res) {
        Write-Output "OK"
        exit 0
    } else {
        Write-Error "CredWrite failed with error code: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
        exit 1
    }
} elseif ($Action -eq "read") {
    $res = [WinCredManager]::Read($Target)
    if ($null -ne $res) {
        Write-Output $res
        exit 0
    } else {
        exit 1
    }
} elseif ($Action -eq "delete") {
    [WinCredManager]::Delete($Target) | Out-Null
    exit 0
}
