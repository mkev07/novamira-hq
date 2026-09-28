// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { chmod, mkdir, stat } from "node:fs/promises";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import {
  POWERSHELL_PREFIX,
  powerShellEnvironment,
  powerShellLiteral,
} from "./powershell.js";

export interface FileSecurity {
  secureDirectory(path: string): Promise<void>;
  secureFile(path: string): Promise<void>;
}

export interface VerifiedFileSecurity extends FileSecurity {
  verifyDirectory(path: string): Promise<boolean>;
  verifyFile(path: string): Promise<boolean>;
}

export class UnixFileSecurity implements VerifiedFileSecurity {
  async secureDirectory(path: string): Promise<void> {
    await chmod(path, 0o700);
  }

  async secureFile(path: string): Promise<void> {
    await chmod(path, 0o600);
  }

  async verifyDirectory(path: string): Promise<boolean> {
    return this.verify(path, 0o700);
  }

  async verifyFile(path: string): Promise<boolean> {
    return this.verify(path, 0o600);
  }

  private async verify(path: string, expectedMode: number): Promise<boolean> {
    const info = await stat(path);
    const ownerMatches =
      process.getuid === undefined || info.uid === process.getuid();
    return ownerMatches && (info.mode & 0o777) === expectedMode;
  }
}

export interface CommandRunner {
  run(command: string, args: readonly string[]): Promise<number>;
  verifyAclBatch?(
    checks: readonly { readonly path: string; readonly directory: boolean }[],
  ): Promise<readonly boolean[]>;
  runOutput?(
    command: string,
    args: readonly string[],
  ): Promise<{ readonly code: number; readonly stdout: string }>;
}

export class SpawnCommandRunner implements CommandRunner {
  private aclWorker: ChildProcessByStdio<Writable, Readable, null> | undefined;
  private aclOutput = "";
  private aclPending:
    | {
        readonly resolve: (value: string) => void;
        readonly reject: (error: Error) => void;
        readonly timeout: ReturnType<typeof setTimeout>;
      }
    | undefined;
  private aclQueue: Promise<void> = Promise.resolve();
  private aclIdle: ReturnType<typeof setTimeout> | undefined;

  async run(command: string, args: readonly string[]): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const child = spawn(command, [...args], {
        stdio: "ignore",
        windowsHide: true,
        env: powerShellEnvironment(),
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === null)
          reject(
            new Error(`${command} terminated with signal ${String(signal)}`),
          );
        else resolve(code);
      });
    });
  }

  async runOutput(
    command: string,
    args: readonly string[],
  ): Promise<{ readonly code: number; readonly stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        env: powerShellEnvironment(),
      });
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.length > 1024) {
          child.kill();
          reject(new Error("ACL verification output exceeded its limit"));
        }
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === null)
          reject(
            new Error(`${command} terminated with signal ${String(signal)}`),
          );
        else resolve({ code, stdout });
      });
    });
  }

  verifyAclBatch(
    checks: readonly { readonly path: string; readonly directory: boolean }[],
  ): Promise<readonly boolean[]> {
    const run = this.aclQueue.then(async () => {
      const response = await this.aclRequest(JSON.stringify(checks));
      if (
        response.length !== checks.length ||
        Array.from(response).some((value) => value !== "0" && value !== "1")
      )
        throw new Error("powershell.exe could not verify storage ACLs");
      return Array.from(response).map((value) => value === "1");
    });
    this.aclQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private aclRequest(request: string): Promise<string> {
    if (this.aclIdle !== undefined) clearTimeout(this.aclIdle);
    if (this.aclWorker === undefined) {
      const worker = spawn(
        "powershell.exe",
        [...POWERSHELL_PREFIX, ACL_WORKER],
        {
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
          env: powerShellEnvironment(),
        },
      );
      this.aclWorker = worker;
      worker.stdout.setEncoding("utf8");
      worker.stdout.on("data", (chunk: string) => {
        if (this.aclWorker !== worker) return;
        this.aclOutput += chunk;
        if (this.aclOutput.length > 1024) {
          this.stopAclWorker(
            new Error("ACL verification output exceeded its limit"),
            worker,
          );
          return;
        }
        const end = this.aclOutput.indexOf("\n");
        if (end < 0) return;
        const answer = this.aclOutput.slice(0, end).trim();
        this.aclOutput = this.aclOutput.slice(end + 1);
        const pending = this.aclPending;
        this.aclPending = undefined;
        if (pending === undefined) {
          this.stopAclWorker(
            new Error("Unexpected ACL verification output"),
            worker,
          );
          return;
        }
        clearTimeout(pending.timeout);
        pending.resolve(answer);
        this.aclIdle = setTimeout(() => {
          this.stopAclWorker(undefined, worker);
        }, 120_000);
        this.aclIdle.unref();
      });
      worker.once("error", (cause: Error) => {
        this.stopAclWorker(cause, worker);
      });
      worker.once("close", () => {
        this.stopAclWorker(new Error("ACL verification helper exited"), worker);
      });
    }
    const worker = this.aclWorker;
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.stopAclWorker(new Error("ACL verification timed out"), worker);
      }, 10_000);
      this.aclPending = { resolve, reject, timeout };
      worker.stdin.write(`${request}\n`, (cause) => {
        if (cause) this.stopAclWorker(cause, worker);
      });
    });
  }

  private stopAclWorker(
    cause = new Error("ACL verification helper stopped"),
    expectedWorker?: ChildProcessByStdio<Writable, Readable, null>,
  ) {
    if (expectedWorker !== undefined && this.aclWorker !== expectedWorker)
      return;
    if (this.aclIdle !== undefined) clearTimeout(this.aclIdle);
    this.aclIdle = undefined;
    const pending = this.aclPending;
    this.aclPending = undefined;
    if (pending !== undefined) {
      clearTimeout(pending.timeout);
      pending.reject(cause);
    }
    const worker = this.aclWorker;
    this.aclWorker = undefined;
    this.aclOutput = "";
    worker?.kill();
  }
}

const ACL_WORKER = [
  "$ErrorActionPreference='Stop'",
  "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "while($null -ne ($line=[Console]::In.ReadLine())){try{",
  "$checks=ConvertFrom-Json -InputObject $line",
  "$answer=foreach($check in $checks){",
  "$item=if($check.directory){[System.IO.DirectoryInfo]::new($check.path)}else{[System.IO.FileInfo]::new($check.path)}",
  "$actual=$item.GetAccessControl([System.Security.AccessControl.AccessControlSections]'Access,Owner')",
  "$owner=$actual.GetOwner([System.Security.Principal.SecurityIdentifier])",
  "$rules=@($actual.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))",
  "$safe=$actual.AreAccessRulesProtected -and $null -ne $owner -and $owner.Value -eq $sid.Value -and $rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $sid.Value -and $rules[0].AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and (($rules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)",
  "if($safe){'1'}else{'0'}",
  "}",
  "[Console]::Out.WriteLine(($answer -join ''))",
  "}catch{[Console]::Out.WriteLine('E')}}",
].join(";");

const UNSAFE_ACL_EXIT_CODE = 3;

export class WindowsFileSecurity implements VerifiedFileSecurity {
  private readonly pendingVerifications: {
    readonly path: string;
    readonly directory: boolean;
    readonly resolve: (safe: boolean) => void;
    readonly reject: (error: Error) => void;
  }[] = [];
  private verificationTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly runner: CommandRunner = new SpawnCommandRunner(),
  ) {}

  async secureDirectory(path: string): Promise<void> {
    await this.apply(path, true);
  }

  async secureFile(path: string): Promise<void> {
    await this.apply(path, false);
  }

  async verifyDirectory(path: string): Promise<boolean> {
    return this.verify(path, true);
  }

  async verifyFile(path: string): Promise<boolean> {
    return this.verify(path, false);
  }

  private async apply(path: string, directory: boolean): Promise<void> {
    const code = await this.runner.run(
      "powershell.exe",
      this.arguments(path, directory, "apply"),
    );
    if (code !== 0)
      throw new Error(`powershell.exe exited with status ${String(code)}`);
  }

  private async verify(path: string, directory: boolean): Promise<boolean> {
    if (
      this.runner.verifyAclBatch !== undefined ||
      this.runner.runOutput !== undefined
    ) {
      return new Promise<boolean>((resolve, reject) => {
        this.pendingVerifications.push({ path, directory, resolve, reject });
        // Config and acknowledgement perform independent lstat calls before
        // reaching here. A short window lets one PowerShell process check all
        // their ACLs, while every read still gets a fresh security verdict.
        this.verificationTimer ??= setTimeout(() => {
          this.verificationTimer = undefined;
          void this.flushVerifications();
        }, 5);
      });
    }
    const code = await this.runner.run(
      "powershell.exe",
      this.arguments(path, directory, "verify"),
    );
    if (code === UNSAFE_ACL_EXIT_CODE) return false;
    if (code !== 0)
      throw new Error(`powershell.exe exited with status ${String(code)}`);
    return true;
  }

  private async flushVerifications(): Promise<void> {
    const batch = this.pendingVerifications.splice(0, 32);
    if (this.pendingVerifications.length > 0 && !this.verificationTimer)
      this.verificationTimer = setTimeout(() => {
        this.verificationTimer = undefined;
        void this.flushVerifications();
      }, 5);
    const checks = batch
      .map(
        ({ path, directory }) =>
          `@{Path=${powerShellLiteral(path)};Directory=$${String(directory)}}`,
      )
      .join(",");
    const script = [
      "$ErrorActionPreference='Stop'",
      "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
      `$checks=@(${checks})`,
      "foreach($check in $checks){try{",
      "$item=if($check.Directory){[System.IO.DirectoryInfo]::new($check.Path)}else{[System.IO.FileInfo]::new($check.Path)}",
      "$actual=$item.GetAccessControl([System.Security.AccessControl.AccessControlSections]'Access,Owner')",
      "$owner=$actual.GetOwner([System.Security.Principal.SecurityIdentifier])",
      "$rules=@($actual.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))",
      "$safe=$actual.AreAccessRulesProtected -and $null -ne $owner -and $owner.Value -eq $sid.Value -and $rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $sid.Value -and $rules[0].AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and (($rules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)",
      "[Console]::Out.WriteLine($(if($safe){'1'}else{'0'}))",
      "}catch{[Console]::Out.WriteLine('E')}}",
    ].join(";");
    try {
      if (this.runner.verifyAclBatch !== undefined) {
        const answers = await this.runner.verifyAclBatch(
          batch.map(({ path, directory }) => ({ path, directory })),
        );
        if (answers.length !== batch.length)
          throw new Error("powershell.exe could not verify storage ACLs");
        for (let index = 0; index < batch.length; index++)
          batch[index]?.resolve(answers[index] === true);
        return;
      }
      const result = await this.runner.runOutput?.("powershell.exe", [
        ...POWERSHELL_PREFIX,
        script,
      ]);
      const answers = result?.stdout.trim().split(/\r?\n/) ?? [];
      if (
        result?.code !== 0 ||
        answers.length !== batch.length ||
        answers.some((answer) => answer !== "0" && answer !== "1")
      )
        throw new Error("powershell.exe could not verify storage ACLs");
      for (let index = 0; index < batch.length; index++)
        batch[index]?.resolve(answers[index] === "1");
    } catch (cause) {
      const error =
        cause instanceof Error ? cause : new Error("ACL verification failed");
      for (const entry of batch) entry.reject(error);
    }
  }

  private arguments(
    path: string,
    directory: boolean,
    action: "apply" | "verify",
  ): string[] {
    const body = [
      "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
      "$item=if($directory){[System.IO.DirectoryInfo]::new($path)}else{[System.IO.FileInfo]::new($path)}",
      "$actual=$item.GetAccessControl([System.Security.AccessControl.AccessControlSections]'Access,Owner')",
      "$owner=$actual.GetOwner([System.Security.Principal.SecurityIdentifier])",
      // A standard user may change the DACL of a file they own, but resetting
      // ownership via Set-Acl can require an elevated privilege. Check the
      // existing owner and retain it when replacing the access rules.
      "if($action -eq 'apply'){if($null -eq $owner -or $owner.Value -ne $sid.Value){throw 'File is not owned by the current user'};$actual.SetAccessRuleProtection($true,$false);$existing=@($actual.GetAccessRules($true,$false,[System.Security.Principal.SecurityIdentifier]));foreach($entry in $existing){$actual.RemoveAccessRuleSpecific($entry)};$inherit=if($directory){[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[System.Security.AccessControl.InheritanceFlags]::None};$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,$inherit,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow);$actual.AddAccessRule($rule);$item.SetAccessControl($actual);$actual=$item.GetAccessControl([System.Security.AccessControl.AccessControlSections]'Access,Owner')}",
      "$rules=@($actual.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))",
      // `$actual.Owner` is the translated NTAccount form (`COMPUTER\user`),
      // which never equals an SID string. Compare SID to SID.
      "$owner=$actual.GetOwner([System.Security.Principal.SecurityIdentifier])",
      "$safe=$actual.AreAccessRulesProtected -and $null -ne $owner -and $owner.Value -eq $sid.Value -and $rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $sid.Value -and $rules[0].AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and (($rules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)",
      // Single quotes only: a double quote here would have to survive Node's
      // Windows argument escaping on the way to powershell.exe.
      `if(-not $safe){[Console]::Error.WriteLine('unsafe protected=' + $actual.AreAccessRulesProtected + ' owner=' + $owner.Value + ' expected=' + $sid.Value + ' rules=' + $rules.Count + ' identity=' + $rules[0].IdentityReference.Value + ' type=' + $rules[0].AccessControlType + ' rights=' + $rules[0].FileSystemRights);$code=${String(UNSAFE_ACL_EXIT_CODE)}}`,
    ].join(";");
    const script = [
      "$ErrorActionPreference='Stop'",
      `$path=${powerShellLiteral(path)}`,
      `$directory=$${String(directory)}`,
      `$action=${powerShellLiteral(action)}`,
      "$code=0",
      // The runner discards the child's output, so this reaches nobody in
      // normal use; it exists for the Windows acceptance script.
      `try{${body}}catch{[Console]::Error.WriteLine($_.Exception.Message);$code=1}`,
      "exit $code",
    ].join(";");
    return [...POWERSHELL_PREFIX, script];
  }
}

export function defaultFileSecurity(
  platform: NodeJS.Platform = process.platform,
): VerifiedFileSecurity {
  return platform === "win32"
    ? new WindowsFileSecurity()
    : new UnixFileSecurity();
}

export async function secureDirectory(
  path: string,
  security: FileSecurity,
): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await security.secureDirectory(path);
}
