<?php
/**
 * Plugin Name: Shravelle Monitoring
 * Description: Real user monitoring (page speed, Core Web Vitals, JS errors) and PHP error/slow-request reporting for WordPress, sent to your Shravelle server.
 * Version: 1.0.0
 * Requires at least: 5.0
 * Requires PHP: 7.0
 * Author: Shravelle
 * License: MIT
 */

if (!defined('ABSPATH')) {
    exit;
}

const SHRAVELLE_OPT = 'shravelle_settings';

function shravelle_settings() {
    return wp_parse_args(get_option(SHRAVELLE_OPT, array()), array(
        'endpoint'       => '',
        'browser_key'    => '',
        'ingest_key'     => '',
        'app'            => sanitize_title(get_bloginfo('name')) ?: 'wordpress',
        'sample_rate'    => '1',
        'php_errors'     => '1',
        'slow_ms'        => '1500',
        'exclude_admin'  => '1',
    ));
}

/* ---------- browser monitoring ---------- */
add_action('wp_enqueue_scripts', function () {
    $s = shravelle_settings();
    if (empty($s['endpoint']) || empty($s['browser_key'])) {
        return;
    }
    wp_enqueue_script('shravelle-browser', plugins_url('shravelle-browser.js', __FILE__), array(), '1.0.0', false);
    $config = array(
        'endpoint'   => esc_url_raw($s['endpoint']),
        'key'        => $s['browser_key'],
        'app'        => $s['app'],
        'release'    => get_bloginfo('version'),
        'sampleRate' => (float) $s['sample_rate'],
    );
    wp_add_inline_script('shravelle-browser', 'Shravelle.init(' . wp_json_encode($config) . ');'
        . (is_user_logged_in() ? 'Shravelle.setUser(' . wp_json_encode('wp-' . get_current_user_id()) . ');' : ''));
}, 1);

/* ---------- server-side: PHP errors and slow requests ---------- */
$GLOBALS['shravelle_start'] = microtime(true);
$GLOBALS['shravelle_logs'] = array();

function shravelle_queue($level, $message, $attrs = array()) {
    $GLOBALS['shravelle_logs'][] = array(
        'timestamp'  => gmdate('Y-m-d\TH:i:s.v\Z'),
        'level'      => $level,
        'message'    => $message,
        'service'    => shravelle_settings()['app'] . '-php',
        'host'       => gethostname(),
        'attributes' => array_map('strval', $attrs),
    );
}

if (shravelle_settings()['php_errors'] === '1') {
    set_error_handler(function ($errno, $errstr, $file, $line) {
        if (!(error_reporting() & $errno)) {
            return false;
        }
        $level = in_array($errno, array(E_WARNING, E_USER_WARNING, E_CORE_WARNING, E_COMPILE_WARNING), true) ? 'WARN' : 'ERROR';
        if (in_array($errno, array(E_NOTICE, E_USER_NOTICE, E_DEPRECATED, E_USER_DEPRECATED, E_STRICT), true)) {
            return false;
        }
        shravelle_queue($level, $errstr, array('exception.type' => 'PHP ' . $errno, 'code.filepath' => $file, 'code.lineno' => $line,
            'url.path' => isset($_SERVER['REQUEST_URI']) ? strtok($_SERVER['REQUEST_URI'], '?') : ''));
        return false; // keep WordPress' own handling
    });
}

register_shutdown_function(function () {
    $s = shravelle_settings();
    if (empty($s['endpoint']) || empty($s['ingest_key'])) {
        return;
    }
    $e = error_get_last();
    if ($e && in_array($e['type'], array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR), true)) {
        shravelle_queue('FATAL', $e['message'], array('exception.type' => 'PHP Fatal', 'code.filepath' => $e['file'], 'code.lineno' => $e['line']));
    }
    $ms = (microtime(true) - $GLOBALS['shravelle_start']) * 1000;
    if ($ms >= (float) $s['slow_ms'] && !(is_admin() && $s['exclude_admin'] === '1')) {
        shravelle_queue('WARN', sprintf('slow request %s took %d ms', isset($_SERVER['REQUEST_URI']) ? strtok($_SERVER['REQUEST_URI'], '?') : '', $ms),
            array('duration_ms' => round($ms), 'db.queries' => get_num_queries(), 'memory_peak_mb' => round(memory_get_peak_usage() / 1048576, 1)));
    }
    if (empty($GLOBALS['shravelle_logs'])) {
        return;
    }
    if (function_exists('fastcgi_finish_request')) {
        fastcgi_finish_request(); // send the page to the visitor first
    }
    wp_remote_post(rtrim($s['endpoint'], '/') . '/v1/logs/simple', array(
        'timeout'  => 3,
        'blocking' => false,
        'headers'  => array('Content-Type' => 'application/json', 'X-API-Key' => $s['ingest_key']),
        'body'     => wp_json_encode($GLOBALS['shravelle_logs']),
    ));
});

/* ---------- deployment markers on updates ---------- */
add_action('upgrader_process_complete', function ($upgrader, $options) {
    $s = shravelle_settings();
    if (empty($s['endpoint']) || empty($s['ingest_key'])) {
        return;
    }
    wp_remote_post(rtrim($s['endpoint'], '/') . '/v1/deployments', array(
        'timeout' => 3, 'blocking' => false,
        'headers' => array('Content-Type' => 'application/json', 'X-API-Key' => $s['ingest_key']),
        'body'    => wp_json_encode(array('service' => $s['app'] . '-php', 'version' => get_bloginfo('version') . '-' . time(),
            'description' => 'WordPress ' . (isset($options['type']) ? $options['type'] : '') . ' update', 'user' => wp_get_current_user()->user_login)),
    ));
}, 10, 2);

/* ---------- settings page ---------- */
add_action('admin_menu', function () {
    add_options_page('Shravelle Monitoring', 'Shravelle', 'manage_options', 'shravelle', 'shravelle_settings_page');
});

add_action('admin_init', function () {
    register_setting('shravelle', SHRAVELLE_OPT, array('sanitize_callback' => function ($in) {
        return array(
            'endpoint'      => esc_url_raw(isset($in['endpoint']) ? $in['endpoint'] : ''),
            'browser_key'   => sanitize_text_field(isset($in['browser_key']) ? $in['browser_key'] : ''),
            'ingest_key'    => sanitize_text_field(isset($in['ingest_key']) ? $in['ingest_key'] : ''),
            'app'           => sanitize_title(isset($in['app']) ? $in['app'] : 'wordpress'),
            'sample_rate'   => (string) min(1, max(0, (float) (isset($in['sample_rate']) ? $in['sample_rate'] : 1))),
            'php_errors'    => empty($in['php_errors']) ? '0' : '1',
            'slow_ms'       => (string) max(100, (int) (isset($in['slow_ms']) ? $in['slow_ms'] : 1500)),
            'exclude_admin' => empty($in['exclude_admin']) ? '0' : '1',
        );
    }));
});

function shravelle_settings_page() {
    $s = shravelle_settings(); ?>
    <div class="wrap">
        <h1>Shravelle Monitoring</h1>
        <form method="post" action="options.php">
            <?php settings_fields('shravelle'); ?>
            <table class="form-table">
                <tr><th>Ingest endpoint</th><td><input class="regular-text" name="<?php echo SHRAVELLE_OPT; ?>[endpoint]" value="<?php echo esc_attr($s['endpoint']); ?>" placeholder="https://ingest.example.com"></td></tr>
                <tr><th>Browser key</th><td><input class="regular-text" name="<?php echo SHRAVELLE_OPT; ?>[browser_key]" value="<?php echo esc_attr($s['browser_key']); ?>" placeholder="shv_brw_..."><p class="description">Public key used by visitors' browsers.</p></td></tr>
                <tr><th>Ingest key</th><td><input class="regular-text" name="<?php echo SHRAVELLE_OPT; ?>[ingest_key]" value="<?php echo esc_attr($s['ingest_key']); ?>" placeholder="shv_ing_..."><p class="description">Secret key for PHP errors and slow requests (sent from the server only).</p></td></tr>
                <tr><th>App name</th><td><input name="<?php echo SHRAVELLE_OPT; ?>[app]" value="<?php echo esc_attr($s['app']); ?>"></td></tr>
                <tr><th>Session sample rate</th><td><input type="number" step="0.01" min="0" max="1" name="<?php echo SHRAVELLE_OPT; ?>[sample_rate]" value="<?php echo esc_attr($s['sample_rate']); ?>"></td></tr>
                <tr><th>Report PHP errors</th><td><input type="checkbox" name="<?php echo SHRAVELLE_OPT; ?>[php_errors]" value="1" <?php checked($s['php_errors'], '1'); ?>></td></tr>
                <tr><th>Slow request threshold (ms)</th><td><input type="number" name="<?php echo SHRAVELLE_OPT; ?>[slow_ms]" value="<?php echo esc_attr($s['slow_ms']); ?>"></td></tr>
                <tr><th>Ignore wp-admin</th><td><input type="checkbox" name="<?php echo SHRAVELLE_OPT; ?>[exclude_admin]" value="1" <?php checked($s['exclude_admin'], '1'); ?>></td></tr>
            </table>
            <?php submit_button(); ?>
        </form>
        <p>For full PHP tracing (every request, database query and external call), also install the OpenTelemetry PHP extension — see the Shravelle docs (sdk/php.md).</p>
    </div>
<?php }
