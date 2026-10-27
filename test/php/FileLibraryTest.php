<?php

declare(strict_types=1);

/**
 * Tests for the reference backend. No dependencies: `php test/php/FileLibraryTest.php`.
 * Every test works in its own scratch folder under the system temp directory.
 */

require __DIR__ . '/../../examples/php/FileLibrary.php';

/** Stands in for PHP's upload handling, which only works inside a real request. */
final class TestLibrary extends FileLibrary
{
    protected function isUploaded(string $tmp): bool
    {
        return is_file($tmp);
    }

    protected function move(string $from, string $to): bool
    {
        return rename($from, $to);
    }
}

$failures = 0;
$count = 0;

function check(bool $ok, string $what): void
{
    global $failures, $count;
    $count++;
    if (!$ok) {
        $failures++;
        echo "FAIL: {$what}\n";
    }
}

function scratch(): string
{
    $dir = sys_get_temp_dir() . '/sn-fm-' . bin2hex(random_bytes(4));
    mkdir($dir);

    return $dir;
}

function wipe(string $dir): void
{
    foreach (scandir($dir) ?: [] as $e) {
        if ($e !== '.' && $e !== '..') {
            is_dir("$dir/$e") ? wipe("$dir/$e") : unlink("$dir/$e");
        }
    }
    rmdir($dir);
}

/** A real 1x1 PNG. */
function png(string $path): void
{
    file_put_contents($path, base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='));
}

function upload(string $name, string $tmp): array
{
    return ['name' => $name, 'tmp_name' => $tmp, 'size' => filesize($tmp), 'error' => UPLOAD_ERR_OK];
}

// ── listing ──────────────────────────────────────────────────────────────

$dir = scratch();
png("$dir/old.png");
touch("$dir/old.png", time() - 100);
png("$dir/new photo.png");
file_put_contents("$dir/report.pdf", '%PDF-1.4');
file_put_contents("$dir/.htaccess", 'deny');
file_put_contents("$dir/shell.php", '<?php');
file_put_contents("$dir/drawing.svg", '<svg/>');
mkdir("$dir/sub");
png("$dir/sub/hidden.png");

$lib = new TestLibrary($dir, '/uploads/');
$images = $lib->list([]);
check(array_column($images['files'], 'name') === ['new photo.png', 'old.png'], 'images only by default, newest first');
check($images['files'][0]['url'] === '/uploads/new%20photo.png', 'urls are encoded and joined to the public url');
check($images['files'][0]['isImage'] === true && is_int($images['files'][0]['size']), 'isImage and size are given');

$all = $lib->list(['filter' => 'all']);
$names = array_column($all['files'], 'name');
check(in_array('report.pdf', $names, true), 'all files includes a pdf');
check(!array_intersect($names, ['.htaccess', 'shell.php', 'drawing.svg', 'sub', 'hidden.png']), 'no dotfiles, scripts, svg, folders or anything below the folder');

check(array_column($lib->list(['filter' => 'all', 'q' => 'REPORT'])['files'], 'name') === ['report.pdf'], 'search ignores case');
check($lib->list(['q' => ['x']])['total'] === 2, 'a search that is not a string is ignored');

$paged = (new TestLibrary($dir, '/u', ['perPage' => 1]))->list(['page' => '99']);
check($paged['page'] === 2 && $paged['pages'] === 2 && $paged['total'] === 2 && count($paged['files']) === 1, 'a page past the end is the last page');
check((new TestLibrary($dir, '/u', ['perPage' => 1]))->list(['page' => '-3'])['page'] === 1, 'a page below one is the first');
wipe($dir);

// ── uploading ────────────────────────────────────────────────────────────

$dir = scratch();
$lib = new TestLibrary($dir, '/uploads');

$tmp = tempnam(sys_get_temp_dir(), 'up');
png($tmp);
$ok = $lib->upload(upload('Été au bord de l\'eau!.PNG', $tmp));
check(isset($ok['file']) && $ok['file']['name'] === 'Ete-au-bord-de-l-eau.png', 'a name is rebuilt from safe characters: ' . json_encode($ok));
check(is_file("$dir/Ete-au-bord-de-l-eau.png"), 'the file is in the folder');

$tmp = tempnam(sys_get_temp_dir(), 'up');
png($tmp);
$again = $lib->upload(upload('Été au bord de l\'eau!.png', $tmp));
check(($again['file']['name'] ?? '') === 'Ete-au-bord-de-l-eau-2.png', 'an upload never replaces a file');

$tmp = tempnam(sys_get_temp_dir(), 'up');
file_put_contents($tmp, '<?php echo 1;');
check(isset($lib->upload(upload('photo.jpg', $tmp))['error']), 'a script named .jpg is refused');
check(isset($lib->upload(upload('photo.php', $tmp))['error']), 'a .php upload is refused');
check(isset($lib->upload(upload('photo.svg', $tmp))['error']), 'an svg upload is refused by default');
check(isset($lib->upload(upload('noext', $tmp))['error']), 'a name with no extension is refused');

$tmp2 = tempnam(sys_get_temp_dir(), 'up');
png($tmp2);
$escaped = $lib->upload(upload('../../etc/evil.png', $tmp2));
check(($escaped['file']['name'] ?? '') === 'evil.png' && is_file("$dir/evil.png"), 'a path in the name is dropped');

$tmp3 = tempnam(sys_get_temp_dir(), 'up');
png($tmp3);
$dot = $lib->upload(upload('.htaccess.png', $tmp3));
check(($dot['file']['name'] ?? '')[0] !== '.', 'a name never starts with a dot');

check($lib->upload(['error' => UPLOAD_ERR_INI_SIZE]) === ['error' => 'The file is too large.'], 'a too-large upload says so');
check(isset($lib->upload(['error' => UPLOAD_ERR_OK, 'tmp_name' => '/nope', 'name' => 'a.png', 'size' => 5])['error']), 'a file PHP did not receive is refused');

$small = new TestLibrary($dir, '/u', ['maxBytes' => 10]);
$tmp4 = tempnam(sys_get_temp_dir(), 'up');
png($tmp4);
check(($small->upload(upload('big.png', $tmp4))['error'] ?? '') === 'The file is too large.', 'maxBytes is honored');

foreach ([$tmp, $tmp4] as $t) {
    @unlink($t);
}
wipe($dir);

try {
    new FileLibrary('/no/such/folder', '/u');
    check(false, 'a missing folder throws');
} catch (InvalidArgumentException $e) {
    check(true, 'a missing folder throws');
}

echo $failures ? "\n{$failures} of {$count} checks failed\n" : "OK ({$count} checks)\n";
exit($failures ? 1 : 0);
