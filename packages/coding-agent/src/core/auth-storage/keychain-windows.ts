/**
 * Windows Credential Manager storage. Each operation runs one PowerShell script (passed as `-EncodedCommand`, so it has
 * no quoting rules) that P/Invokes advapi32 `CredWriteW`/`CredReadW`/`CredDeleteW` for a generic credential. The secret
 * reaches the script on stdin only; the script text and argv never contain it. The provider id is validated by the caller
 * and is the only interpolated value; it is restricted to `[a-z0-9._-]`.
 */

/** Exit code the scripts use for "no such credential", distinct from a real failure (1). */
export const WINDOWS_NOT_FOUND_EXIT = 44;
/** CRED_MAX_CREDENTIAL_BLOB_SIZE is 2560 bytes; the secret is stored as UTF-8. */
const WINDOWS_MAX_SECRET_BYTES = 2500;
const ERROR_NOT_FOUND = 1168;
const POWERSHELL_FLAGS = ["-NoProfile", "-NonInteractive"];

const CSHARP = `
using System; using System.Runtime.InteropServices; using System.Text;
public static class OctocodeCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct CREDENTIAL { public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint BlobSize; public IntPtr Blob;
    public uint Persist; public uint AttrCount; public IntPtr Attrs; public string Alias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredWriteW(ref CREDENTIAL c, uint f);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredReadW(string t, uint type, uint f, out IntPtr c);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredDeleteW(string t, uint type, uint f);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr c);
  static void Fail() { int e = Marshal.GetLastWin32Error(); if (e == ${ERROR_NOT_FOUND}) Environment.Exit(${WINDOWS_NOT_FOUND_EXIT}); throw new System.ComponentModel.Win32Exception(e); }
  public static void Write(string target, string user, string secret) {
    byte[] b = new UTF8Encoding(false).GetBytes(secret);
    IntPtr p = Marshal.AllocHGlobal(b.Length);
    try {
      Marshal.Copy(b, 0, p, b.Length);
      CREDENTIAL c = new CREDENTIAL(); c.Type = 1; c.TargetName = target; c.UserName = user; c.Persist = 2;
      c.BlobSize = (uint)b.Length; c.Blob = p;
      if (!CredWriteW(ref c, 0)) Fail();
    } finally { Array.Clear(b, 0, b.Length); Marshal.FreeHGlobal(p); }
  }
  public static string Read(string target) {
    IntPtr p; if (!CredReadW(target, 1, 0, out p)) Fail();
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] b = new byte[c.BlobSize]; Marshal.Copy(c.Blob, b, 0, b.Length);
      return new UTF8Encoding(false).GetString(b);
    } finally { CredFree(p); }
  }
  public static void Delete(string target) { if (!CredDeleteW(target, 1, 0)) Fail(); }
}`;

function script(action: string, service: string, provider: string): string {
	return [
		"$ErrorActionPreference = 'Stop'",
		"try {",
		`Add-Type -TypeDefinition @'${CSHARP}\n'@`,
		"$utf8 = New-Object System.Text.UTF8Encoding($false)",
		"[Console]::InputEncoding = $utf8",
		"[Console]::OutputEncoding = $utf8",
		action,
		"exit 0",
		"} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
	]
		.join("\n")
		.replaceAll("__TARGET__", `${service}/${provider}`)
		.replaceAll("__USER__", provider);
}

function encoded(source: string): string {
	return Buffer.from(source, "utf16le").toString("base64");
}

function args(source: string): string[] {
	return [...POWERSHELL_FLAGS, "-EncodedCommand", encoded(source)];
}

export interface WindowsSpec {
	name: string;
	file: string;
	store(provider: string, secret: string): { args: string[]; input: string };
	remove(provider: string): string[];
	reference(provider: string): string;
	isNotFound(result: { code: number | null; stderr: string }): boolean;
	maxInputBytes: number;
}

/** `file` is the resolved executable; the `!command` reference uses its bare `command` name so it survives spaces in paths. */
export function windowsSpec(file: string, command: string, service: string): WindowsSpec {
	const store = (provider: string) =>
		script(
			"$s = [Console]::In.ReadToEnd().TrimStart([char]0xFEFF)\n[OctocodeCred]::Write('__TARGET__', '__USER__', $s)",
			service,
			provider,
		);
	const read = (provider: string) =>
		script("[Console]::Out.Write([OctocodeCred]::Read('__TARGET__'))", service, provider);
	const remove = (provider: string) => script("[OctocodeCred]::Delete('__TARGET__')", service, provider);
	return {
		name: "Windows Credential Manager",
		file,
		store: (provider, secret) => ({ args: args(store(provider)), input: secret }),
		remove: (provider) => args(remove(provider)),
		reference: (provider) => `!${command} ${args(read(provider)).join(" ")}`,
		isNotFound: (result) => result.code === WINDOWS_NOT_FOUND_EXIT,
		maxInputBytes: WINDOWS_MAX_SECRET_BYTES,
	};
}
