// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { redact } from "./redact.js";

/** Only the upload grant's root token is intended for the calling tool. */
export function redactAbilityResult(value: unknown, ability?: string): unknown {
  const safe = redact(value);
  if (
    ability === "novamira/create-upload-link" &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "upload_token") &&
    typeof (value as Record<string, unknown>).upload_token === "string" &&
    safe !== null &&
    typeof safe === "object" &&
    !Array.isArray(safe)
  ) {
    return {
      ...safe,
      upload_token: (value as Record<string, unknown>).upload_token,
    };
  }
  return safe;
}
