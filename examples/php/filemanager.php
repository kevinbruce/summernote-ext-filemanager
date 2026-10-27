<?php

declare(strict_types=1);

/**
 * The endpoint summernote-ext-filemanager talks to: GET lists the folder,
 * POST uploads into it. Point the plugin's `url` option here.
 *
 * Copy it and make it yours. Three things are yours to decide, and the
 * example refuses rather than guess:
 *
 *   1. WHO may use it: may_use_library() below. As shipped it only answers
 *      under PHP's built-in development server (php -S), so a copy dropped
 *      onto a real site does nothing until you replace it.
 *   2. WHERE the files live: LIBRARY_DIR and LIBRARY_URL.
 *   3. That the folder cannot RUN anything it holds: serve it as static files
 *      only (see the README for Apache and nginx).
 */

require __DIR__ . '/FileLibrary.php';

const LIBRARY_DIR = __DIR__ . '/uploads';
const LIBRARY_URL = '/examples/php/uploads';

/**
 * Replace this with your own sign-in check, e.g.
 *     session_start();
 *     return !empty($_SESSION['user_id']);
 */
function may_use_library(): bool
{
    return PHP_SAPI === 'cli-server';
}

function answer(int $status, array $body): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: no-store');
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

if (!may_use_library()) {
    answer(403, ['error' => 'You need to be signed in to use the file library.']);
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// A cross-site form can post here with the visitor's cookies, but it cannot
// set a custom header without the browser asking first, and jQuery sets this
// one on every same-origin request. Check your CSRF token here as well if
// your site has one (send it with the plugin's `headers` option).
if ($method === 'POST' && ($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'XMLHttpRequest') {
    answer(403, ['error' => 'Refused.']);
}

if (!is_dir(LIBRARY_DIR)) {
    mkdir(LIBRARY_DIR, 0755, true);
}

$library = new FileLibrary(LIBRARY_DIR, LIBRARY_URL);

if ($method === 'GET') {
    answer(200, $library->list($_GET));
}

if ($method === 'POST') {
    if (!isset($_FILES['file']) || !is_array($_FILES['file']) || is_array($_FILES['file']['name'] ?? null)) {
        answer(400, ['error' => 'Send one file, as "file".']);
    }
    $result = $library->upload($_FILES['file']);
    answer(isset($result['error']) ? 422 : 201, $result);
}

header('Allow: GET, POST');
answer(405, ['error' => 'Use GET to list and POST to upload.']);
