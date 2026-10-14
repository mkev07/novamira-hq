// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Temporary must-use installer for cPanel accounts without WP Toolkit.
 *
 * Runs once on WordPress `init`, never reads request data, never ends the
 * request, prints nothing, and removes itself whatever the outcome. HQ reads
 * status.json through the cPanel file API and removes the working directory.
 *
 * The file must parse on any PHP a WordPress site may run (5.6 or newer), so
 * it reaches its own requirements check and reports instead of breaking the
 * site: no PHP 7-only syntax such as `??` or immediately invoked closures.
 */
export function cpanelInstaller(options: {
  readonly slug: string;
  readonly domain: string;
  readonly digest: string | null;
  readonly enableAi: boolean;
  readonly minimumVersion: string;
  /** Seconds from the file's own modification time (the server's clock). */
  readonly ttl: number;
}): string {
  if (!/^novamira-hq-setup-[0-9a-f-]{36}$/.test(options.slug))
    throw new Error("invalid installer slug");
  if (!Number.isSafeInteger(options.ttl) || options.ttl <= 0)
    throw new Error("invalid installer ttl");
  // Every variable value crosses into PHP as base64 JSON, never as source text.
  const encoded = Buffer.from(
    JSON.stringify({
      domain: options.domain,
      digest: options.digest,
      enableAi: options.enableAi,
      minimumVersion: options.minimumVersion,
      ttl: options.ttl,
    }),
  ).toString("base64");
  return `<?php
// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Novamira HQ temporary setup. Removes itself after one run.
if (!defined('ABSPATH')) { return; }
add_action('init', function () {
    $dir = WP_CONTENT_DIR . '/${options.slug}';
    $status = $dir . '/status.json';
    // The first outcome is final: status.json is created, never overwritten.
    $finish = function (array $result) use ($dir, $status) {
        $handle = @fopen($status, 'x');
        if ($handle !== false) { fwrite($handle, json_encode($result)); fclose($handle); }
        if (is_file($dir . '/novamira.zip') && !is_link($dir . '/novamira.zip')) { @unlink($dir . '/novamira.zip'); }
        @unlink(__FILE__);
    };
    $run = function () use ($dir, $status, $finish) {
        if (!is_dir($dir) || is_link($dir)) { @unlink(__FILE__); return; }
        $lock = @fopen($dir . '/lock', 'c');
        if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) { return; }
        try {
            if (file_exists($status)) { $finish(array()); return; }
            $o = json_decode(base64_decode('${encoded}'), true);
            clearstatcache();
            $created = @filemtime(__FILE__);
            if (!is_array($o) || $created === false || time() > $created + $o['ttl']) { $finish(array('ok' => false, 'error' => 'expired')); return; }
            $expires = $created + $o['ttl'];
            // A request answered under another host name is not this site's
            // run: it leaves the installer in place, within its expiry.
            if (wp_parse_url(home_url(), PHP_URL_HOST) !== $o['domain']) { return; }
            if (is_multisite()) { $finish(array('ok' => false, 'error' => 'multisite')); return; }
            if (version_compare(PHP_VERSION, '8.0', '<') || version_compare(get_bloginfo('version'), '6.9', '<')) { $finish(array('ok' => false, 'error' => 'requirements')); return; }
            require_once ABSPATH . 'wp-admin/includes/plugin.php';
            $target = WP_PLUGIN_DIR . '/novamira';
            if ($o['digest'] !== null) {
                $extract = function () use ($o, $dir, $target, $expires) {
                    if (file_exists($target) || is_link($target)) { return 'exists'; }
                    $archive = $dir . '/novamira.zip';
                    if (is_link($archive) || !is_file($archive) || hash_file('sha256', $archive) !== $o['digest']) { return 'digest'; }
                    if (!class_exists('ZipArchive')) { return 'zip'; }
                    $zip = new ZipArchive();
                    if ($zip->open($archive) !== true || $zip->numFiles > 5000) { return 'archive'; }
                    $total = 0;
                    $files = array();
                    for ($i = 0; $i < $zip->numFiles; $i++) {
                        $entry = $zip->statIndex($i);
                        $name = $entry['name'];
                        $total += $entry['size'];
                        if ($total > 52428800 || !str_starts_with($name, 'novamira/') || str_contains($name, '\\\\') || str_contains($name, "\\0") || preg_match('~(^|/)\\.\\.?(/|$)~', $name)) { $zip->close(); return 'unsafe'; }
                        $opsys = 0; $attributes = 0;
                        if ($zip->getExternalAttributesIndex($i, $opsys, $attributes) && (($attributes >> 16) & 0170000) === 0120000) { $zip->close(); return 'link'; }
                        if (substr($name, -1) !== '/') { $files[$name] = (int) $entry['size']; }
                    }
                    $zip->close();
                    require_once ABSPATH . 'wp-admin/includes/file.php';
                    if (file_exists($dir . '/payload') || !WP_Filesystem()) { return 'filesystem'; }
                    if (is_wp_error(unzip_file($archive, $dir . '/payload'))) { return 'extract'; }
                    // Every file the archive lists, whole, before anything moves.
                    clearstatcache();
                    foreach ($files as $name => $size) {
                        $path = $dir . '/payload/' . $name;
                        if (is_link($path) || !is_file($path) || filesize($path) !== $size) { return 'incomplete'; }
                    }
                    $main = $dir . '/payload/novamira/novamira.php';
                    if (!is_file($main)) { return 'entry'; }
                    $data = get_plugin_data($main, false, false);
                    if (version_compare($data['Version'], $o['minimumVersion'], '<')) { return 'old'; }
                    if (time() > $expires) { return 'incomplete'; }
                    if (file_exists($target) || is_link($target)) { return 'exists'; }
                    if (!@rename($dir . '/payload/novamira', $target)) { return 'destination'; }
                    clearstatcache();
                    if (is_link($target) || !is_file($target . '/novamira.php')) {
                        // Never leave a half-populated plugin folder behind.
                        @rename($target, $dir . '/payload/novamira');
                        return 'incomplete';
                    }
                    @rmdir($dir . '/payload');
                    wp_clean_plugins_cache();
                    return null;
                };
                $result = $extract();
                if ($result !== null) { $finish(array('ok' => false, 'error' => $result)); return; }
            }
            if (!is_file($target . '/novamira.php') || is_link($target)) { $finish(array('ok' => false, 'error' => 'missing')); return; }
            $data = get_plugin_data($target . '/novamira.php', false, false);
            if (version_compare($data['Version'], $o['minimumVersion'], '<')) { $finish(array('ok' => false, 'error' => 'old')); return; }
            if (!is_plugin_active('novamira/novamira.php')) {
                $activated = activate_plugin('novamira/novamira.php');
                // Output during activation is reported as an error, yet the
                // plugin is active: only the active state decides.
                if (is_wp_error($activated) && $activated->get_error_code() !== 'unexpected_output') { $finish(array('ok' => false, 'error' => 'activation')); return; }
                if (!is_plugin_active('novamira/novamira.php')) { $finish(array('ok' => false, 'error' => 'activation')); return; }
            }
            if ($o['enableAi']) {
                update_option('novamira_ai_abilities_domain', $o['domain']);
                update_option('novamira_ai_abilities_enabled', '1');
                if ((string) get_option('novamira_ai_abilities_enabled') !== '1' || get_option('novamira_ai_abilities_domain') !== $o['domain']) { $finish(array('ok' => false, 'error' => 'options')); return; }
            }
            $finish(array('ok' => true, 'version' => (string) $data['Version'], 'aiEnabled' => (bool) $o['enableAi']));
        } catch (\\Throwable $e) {
            $finish(array('ok' => false, 'error' => 'exception'));
        } catch (\\Exception $e) {
            $finish(array('ok' => false, 'error' => 'exception'));
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    };
    // Nothing the run prints or warns about reaches the visitor.
    $level = ob_get_level();
    ob_start();
    set_error_handler(function ($number) {
        return ($number & (E_WARNING | E_NOTICE | E_DEPRECATED | E_USER_WARNING | E_USER_NOTICE | E_USER_DEPRECATED)) !== 0;
    });
    try {
        $run();
    } catch (\\Throwable $e) {
    } catch (\\Exception $e) {
    }
    restore_error_handler();
    while (ob_get_level() > $level) { ob_end_clean(); }
}, 1);
`;
}
