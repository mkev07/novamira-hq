// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the cPanel and WHM clients share: they act on the same cPanel accounts
 * through the same modules, so the parts that do not depend on how an account
 * is reached live here once.
 */

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ActionRequest } from "../client.js";
import { unsupportedOperation } from "../client.js";
import type { ProviderKind } from "../../config/schema.js";
import type { ActionResult, OperationStatus } from "../types.js";
import { setupWithInstaller } from "./cpanel-installer-setup.js";
import type { CpanelWordPress } from "./cpanel-sites.js";
import { setupWithToolkit } from "./cpanel-toolkit-setup.js";
import type { CpanelApi } from "./cpanel-uapi.js";

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** The real timer; tests replace it so they never really wait. */
export const defaultSleep: Sleep = (ms, signal) =>
  delay(ms, undefined, signal === undefined ? undefined : { signal });

export const BACKUP_STARTED =
  "cPanel is creating the account backup in the background. It can take several minutes; check hosting_backups_list for the new file.";

/** What a backup that was started and not awaited answers. */
export function backupStartedResult(provider: ProviderKind): ActionResult {
  return {
    provider,
    action: "backups.create",
    status: 202,
    message: BACKUP_STARTED,
    raw: { started: true, note: BACKUP_STARTED },
  };
}

/** A finished action keeps its status here so HQ can confirm it once. */
export class CompletedActions {
  readonly #provider: ProviderKind;
  readonly #completed = new Map<string, OperationStatus>();

  constructor(provider: ProviderKind) {
    this.#provider = provider;
  }

  record(action: string, raw: unknown): ActionResult {
    const operationId = randomUUID();
    const status: OperationStatus = {
      provider: this.#provider,
      operationId,
      status: 200,
      done: true,
      failed: false,
      raw: { completed: true },
    };
    if (this.#completed.size >= 32)
      this.#completed.delete(this.#completed.keys().next().value ?? "");
    this.#completed.set(operationId, status);
    return {
      provider: this.#provider,
      action,
      status: 200,
      operationId,
      raw,
    };
  }

  status(operationId: string): Promise<OperationStatus> {
    const completed = this.#completed.get(operationId);
    return completed
      ? Promise.resolve(completed)
      : Promise.reject(
          unsupportedOperation(this.#provider, "unknown operation status"),
        );
  }
}

/**
 * Novamira setup for one site: through its WP Toolkit installation when it has
 * one, otherwise through the consented temporary installer.
 */
export function dispatchSetup(
  api: CpanelApi,
  fetcher: typeof fetch,
  site: CpanelWordPress,
  request: Extract<ActionRequest, { kind: "setup-novamira" }>,
  sleep: Sleep,
): Promise<ActionResult> {
  return site.toolkitId !== undefined
    ? setupWithToolkit(api, fetcher, site, request, sleep)
    : setupWithInstaller(api, fetcher, site, request, {
        sleep,
        uuid: randomUUID,
        now: Date.now,
      });
}
