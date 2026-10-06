// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The **Connect** action: `novamira auth login <url>`, spawned as a child.
 *
 * **What the Go did.** Nothing — there was no Connect action. Go's dashboard
 * "connected" a site by posting a WordPress URL and an Application Password to
 * `/_dashboard/sites/save`, creating the password over the site's REST API and
 * writing the credential into its own config as a `site_profiles` entry. Every
 * one of those steps is deleted under the boundary rule, and none of it is
 * ported: HQ holds no site token and makes no request to a configured site.
 *
 * **What HQ does instead** (plan §8, decision 3). It spawns the site CLI and
 * gets out of the way. The child owns the browser launch, the OAuth callback and
 * the credential write; HQ observes only whether the child's v1 envelope said
 * `ok`. That is why this module lives in `src/integration/` and not in
 * `src/web/`: `CLAUDE.md` makes this package "the **only** place HQ runs
 * `novamira`", and a Connect button in a view calling `spawn` would put a child
 * process behind a renderer.
 *
 * **The rules, all load-bearing.**
 *
 * - `shell: false` and an argv array — inherited from {@link SpawnChild}, which
 *   has no other mode. Only the public URL and an optional validated profile
 *   name are passed. Named profiles are checked before starting a new login;
 *   an already authorized profile needs no interactive authorization.
 * - Its own timeout and its own `AbortSignal`. {@link AUTH_LOGIN_TIMEOUT_MS} is
 *   five minutes rather than the ten seconds a query gets: this is an
 *   interactive OAuth flow with a human in it, and killing it at ten seconds
 *   would make Connect look broken on every first use.
 * - Child output is parsed for the envelope's `ok` and then **discarded**. It is
 *   never persisted, never logged, never rendered, and never attached to an
 *   error. A failure surfaces as the fixed `unavailableHint(reason)` sentence,
 *   which is why {@link ConnectOutcome}'s failure arm carries a reason enum and
 *   has nowhere to put a string.
 * - It resolves for every failure and never throws, exactly as
 *   `connectionStates` does. Integration failure is a state.
 *
 * **Hand-off.** 6b-2's `/_dashboard/connect` handler validates `?url=` with
 * `normalizeSiteUrl` from `src/provisioning/site-url.ts` *before* the value
 * reaches {@link authLoginArgs}, refreshes connection state on success, and
 * patches a toast carrying `unavailableHint(reason)` — never child text — on
 * failure.
 */

import type { ConnectOutcome, UnavailableReason } from "../connection-state.js";
import { CliError } from "../errors.js";
import { isSiteProfileName } from "../site-profiles.js";
import { interpretChildOutcome } from "./classify.js";
import {
  authStatusArgs,
  parseSitesList,
  siteCliChildEnv,
  sitesListArgs,
} from "./site-cli.js";
import { verdictFor } from "./verdict.js";
import { originOf } from "./origin.js";
import {
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_MAX_STDOUT_BYTES,
  type SpawnChild,
} from "./spawn.js";
import type { ResolveSiteCli, SiteCliResolution } from "./resolve.js";

export type { ConnectOutcome } from "../connection-state.js";

/**
 * Five minutes. An interactive OAuth flow, not a query: the operator has to
 * reach a browser, authenticate, and approve. `connectionStates`' ten-second
 * per-child timeout would abort a healthy login.
 */
export const AUTH_LOGIN_TIMEOUT_MS = 300_000;

/**
 * `novamira --json --quiet auth login <url>`.
 *
 * Globals first, as the CLI's grammar specifies. No `--timeout`: the CLI's own
 * request budget must not cut short a flow that waits on a human, and HQ's
 * bound is the child timeout plus the abort signal below. No `--name`, and no
 * second argument of any kind.
 */
export function authLoginArgs(
  siteUrl: string,
  name?: string,
  device = false,
): readonly string[] {
  return [
    "--json",
    "--quiet",
    "auth",
    "login",
    siteUrl,
    ...(name === undefined ? [] : ["--name", name]),
    ...(device ? ["--device"] : []),
  ];
}

/**
 * ponytail: headless fork — `NOVAMIRA_HQ_DEVICE_LOGIN=1` runs `auth login --device`, since a
 * server has no browser for the loopback flow. The site's device code lives 10 minutes.
 */
export const DEVICE_LOGIN_TIMEOUT_MS = 600_000;

export interface DeviceInstructions {
  readonly url: string;
  readonly code: string;
  /** From "The code expires in N minutes/seconds."; absent if the CLI did not say. */
  readonly expiresInSeconds?: number;
}

/**
 * The verification page and user code out of the CLI's device prompt, or
 * `undefined`. Only a page on the site being connected and a short code-shaped
 * value are accepted, so no other child text can reach the dashboard.
 */
export function parseDeviceInstructions(
  stderr: string,
  siteUrl: string,
): DeviceInstructions | undefined {
  const match =
    /^(https:\/\/\S+)\r?\nEnter the code: ([A-Z0-9-]{4,20})\r?$/m.exec(stderr);
  if (match === null) return undefined;
  const [, url = "", code = ""] = match;
  if (originOf(url) !== originOf(siteUrl)) return undefined;
  const lifetime = /^The code expires in (\d{1,4}) (seconds|minutes)\./m.exec(
    stderr,
  );
  if (lifetime === null) return { url, code };
  const [, amount = "0", unit] = lifetime;
  return {
    url,
    code,
    expiresInSeconds: Number(amount) * (unit === "minutes" ? 60 : 1),
  };
}

export interface ConnectActionOptions {
  readonly spawn: SpawnChild;
  readonly resolve: ResolveSiteCli;
  /** The injected process environment, passed through to the child. */
  readonly environment: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
}

const CONNECTED: ConnectOutcome = Object.freeze({ kind: "connected" as const });

function failed(reason: UnavailableReason): ConnectOutcome {
  return { kind: "failed", reason };
}

/**
 * Build the action. It is a factory rather than a method so `connection.ts` can
 * compose it into `SiteCliIntegration` without either sibling importing the
 * other's implementation.
 */
export function createConnectAction(
  options: ConnectActionOptions,
): (
  siteUrl: string,
  name?: string,
  onDevice?: (instructions: DeviceInstructions) => void,
) => Promise<ConnectOutcome> {
  const device = options.environment.NOVAMIRA_HQ_DEVICE_LOGIN === "1";
  const timeoutMs =
    options.timeoutMs ??
    (device ? DEVICE_LOGIN_TIMEOUT_MS : AUTH_LOGIN_TIMEOUT_MS);
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;

/**
   * The profile that already holds `siteUrl`, if any. One site gets one
   * profile: connecting it again, with or without another name, reuses the
   * existing one instead of creating a duplicate. A listing that fails is not
   * a reason to refuse the connection, so it answers `undefined`.
   */
  const existingProfile = async (
    resolution: SiteCliResolution,
    siteUrl: string,
    preferred: string | undefined,
  ): Promise<string | undefined> => {
    const listTimeoutMs = Math.min(timeoutMs, 10_000);
    const listed = interpretChildOutcome(
      await options.spawn({
        command: resolution.command,
        args: [...resolution.prefixArgs, ...sitesListArgs(listTimeoutMs)],
        env: siteCliChildEnv(options.environment),
        timeoutMs: listTimeoutMs,
        maxStdoutBytes,
        maxStderrBytes,
        signal: AbortSignal.timeout(listTimeoutMs + 1_000),
      }),
    );
    if (listed.kind !== "data") return undefined;
    const matches = (parseSitesList(listed.data) ?? [])
      .filter((profile) => profile.siteUrl === siteUrl)
      .map((profile) => profile.name);
    if (preferred !== undefined && matches.includes(preferred))
      return preferred;
    return matches[0];
  };

  return async (
    siteUrl: string,
    requestedName?: string,
    onDevice?: (instructions: DeviceInstructions) => void,
  ): Promise<ConnectOutcome> => {
    let name = requestedName;
    if (name !== undefined && !isSiteProfileName(name)) {
      throw new CliError(
        "usage_error",
        "A Novamira site profile name must start with a letter or digit and may contain only letters, digits, '.', '_' and '-'.",
      );
    }
    let resolution: SiteCliResolution | undefined;
    try {
      resolution = await options.resolve();
    } catch {
      // A probe that throws is a failed probe, not an absent CLI.
      return failed("cli_failed");
    }
    if (resolution === undefined) return failed("cli_absent");

    const existing = await existingProfile(resolution, siteUrl, name);
    const reused = existing !== undefined && existing !== name;
    if (existing !== undefined) name = existing;
    const connected: ConnectOutcome = reused
      ? { kind: "connected", existingProfile: existing }
      : CONNECTED;

    // A stale dashboard row must not reauthorize an already usable profile.
    // Query only the explicitly selected profile; never use the CLI default.
    if (name !== undefined) {
      const checkTimeoutMs = Math.min(timeoutMs, 10_000);
      const check = await options.spawn({
        command: resolution.command,
        args: [
          ...resolution.prefixArgs,
          ...authStatusArgs(checkTimeoutMs, name),
        ],
        env: siteCliChildEnv(options.environment),
        timeoutMs: checkTimeoutMs,
        maxStdoutBytes,
        maxStderrBytes,
        signal: AbortSignal.timeout(checkTimeoutMs + 1_000),
      });
      const { verdict, status } = verdictFor(interpretChildOutcome(check));
      if (
        status?.siteUrl !== undefined &&
        originOf(status.siteUrl) !== originOf(siteUrl)
      )
        return failed("malformed_output");
      if (status?.restError === "network_error")
        return failed("site_unreachable");
      if (verdict.kind === "connected") return connected;
      if (verdict.kind === "unavailable") return failed(verdict.reason);
      // Missing profiles (including a new custom name) or confirmed auth
      // failures may continue to the existing interactive login flow.
    }

    // One login, one deadline. `AbortSignal.timeout` is the same mechanism the
    // refresh uses; the child timer is the belt to its braces.
    const signal = AbortSignal.timeout(timeoutMs + 1_000);
    let shown = false;
    const outcome = await options.spawn({
      command: resolution.command,
      args: [...resolution.prefixArgs, ...authLoginArgs(siteUrl, name, device)],
      env: siteCliChildEnv(options.environment),
      timeoutMs,
      maxStdoutBytes,
      maxStderrBytes,
      signal,
      ...(device && onDevice !== undefined
        ? {
            onStderr: (text: string) => {
              if (shown) return;
              const instructions = parseDeviceInstructions(text, siteUrl);
              if (instructions === undefined) return;
              shown = true;
              onDevice(instructions);
            },
          }
        : {}),
    });

    const result = interpretChildOutcome(outcome);
    switch (result.kind) {
      case "data":
        // The payload is deliberately not inspected. `ok: true` from
        // `auth login` is the CLI saying the credential is written; anything
        // HQ read out of it would be site state HQ must not hold.
        return connected;
      case "site_missing":
        // `site_not_found` from a command that creates the profile means the
        // installed CLI does not mean what HQ means by `auth login <url>`.
        return failed("cli_incompatible");
      case "failure":
        return failed(result.reason);
    }
  };
}
