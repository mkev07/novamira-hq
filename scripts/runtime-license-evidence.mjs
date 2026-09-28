// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Reviewed choices for declarations whose archives omit standalone notice files.
// This is deliberately not a permissive SPDX parser or a license-compatibility verdict.
const choices = new Map([
  ["MIT", ["MIT"]],
  ["Apache-2.0", ["Apache-2.0"]],
  ["CC0-1.0", ["CC0-1.0"]],
  ["MIT OR Apache-2.0", ["MIT", "Apache-2.0"]],
  ["MIT/Apache-2.0", ["MIT", "Apache-2.0"]],
]);

export function validateDeclaredLicense(item, evidence) {
  const id = `${item.name}@${item.version}`;
  if (!evidence) throw new Error(`Missing license evidence: ${id}`);
  if (
    evidence.name !== item.name ||
    evidence.version !== item.version ||
    evidence.archiveSha256 !== item.checksum ||
    evidence.declaredLicense !== item.license ||
    !/^[a-f0-9]{64}$/.test(evidence.manifestSha256 ?? "")
  )
    throw new Error(`Changed license declaration or archive: ${id}`);
  if (!choices.get(item.license)?.includes(evidence.selectedLicense))
    throw new Error(`Unreviewed or conflicting license selection: ${id}`);
  if (
    !Array.isArray(evidence.authors) ||
    !evidence.authors.every((value) => typeof value === "string") ||
    !Array.isArray(evidence.copyrightHeaders) ||
    !evidence.copyrightHeaders.every(
      (header) =>
        typeof header.text === "string" &&
        header.text.length > 0 &&
        Array.isArray(header.paths) &&
        header.paths.length > 0 &&
        header.paths.every((value) => typeof value === "string"),
    )
  )
    throw new Error(`Invalid attribution evidence: ${id}`);
  return evidence.selectedLicense;
}
