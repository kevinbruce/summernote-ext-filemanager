<?php

declare(strict_types=1);

/**
 * A reference backend for summernote-ext-filemanager: one folder of files,
 * listed and searched, with uploads into it.
 *
 * Nothing a request sends names a path. The folder is fixed when the object
 * is made, a listing only ever reads that folder (not below it), and an
 * upload's name is rebuilt from safe characters. What may be uploaded is an
 * allowlist of extensions, and an image must really be one.
 *
 * Who may use it is NOT decided here: see filemanager.php, which must check
 * that before it calls anything.
 */
class FileLibrary
{
    /** Extensions offered as images. SVG is left out: it can carry script. */
    public const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'];

    /** What may be uploaded and listed by default. */
    public const DEFAULT_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif',
        'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'zip'];

    private string $dir;
    private string $publicUrl;
    /** @var list<string> */
    private array $extensions;
    private int $maxBytes;
    private int $perPage;

    /**
     * @param string $dir       the folder on disk, which must exist
     * @param string $publicUrl the URL that folder is served at, e.g. "/uploads"
     * @param array{extensions?: list<string>, maxBytes?: int, perPage?: int} $options
     */
    public function __construct(string $dir, string $publicUrl, array $options = [])
    {
        $real = realpath($dir);
        if ($real === false || !is_dir($real)) {
            throw new InvalidArgumentException('The library folder does not exist.');
        }
        $this->dir = $real;
        $this->publicUrl = rtrim($publicUrl, '/');
        $this->extensions = array_values(array_map('strtolower', $options['extensions'] ?? self::DEFAULT_EXTENSIONS));
        $this->maxBytes = (int) ($options['maxBytes'] ?? 10 * 1024 * 1024);
        $this->perPage = max(1, (int) ($options['perPage'] ?? 40));
    }

    /**
     * One page of the folder, newest first.
     *
     * @param array{q?: mixed, filter?: mixed, page?: mixed} $query
     * @return array{files: list<array<string, mixed>>, page: int, pages: int, total: int}
     */
    public function list(array $query): array
    {
        $search = trim(is_string($query['q'] ?? null) ? $query['q'] : '');
        $imagesOnly = ($query['filter'] ?? 'images') !== 'all';

        $found = [];
        foreach (scandir($this->dir) ?: [] as $entry) {
            $path = $this->dir . DIRECTORY_SEPARATOR . $entry;
            // No dotfiles (an .htaccess in an uploads folder matters), no folders.
            if ($entry[0] === '.' || !is_file($path)) {
                continue;
            }
            $ext = strtolower(pathinfo($entry, PATHINFO_EXTENSION));
            if (!in_array($ext, $this->extensions, true)) {
                continue;
            }
            $isImage = in_array($ext, self::IMAGE_EXTENSIONS, true);
            if ($imagesOnly && !$isImage) {
                continue;
            }
            if ($search !== '' && mb_stripos($entry, $search) === false) {
                continue;
            }
            $found[] = ['entry' => $entry, 'isImage' => $isImage, 'mtime' => (int) filemtime($path), 'size' => (int) filesize($path)];
        }

        // Newest first: the file somebody just uploaded is the one they want.
        usort($found, static fn(array $a, array $b): int => [$b['mtime'], $a['entry']] <=> [$a['mtime'], $b['entry']]);

        $total = count($found);
        $pages = max(1, (int) ceil($total / $this->perPage));
        $page = min(max(1, (int) ($query['page'] ?? 1)), $pages);

        $files = array_map(fn(array $f): array => $this->describe($f['entry'], $f['isImage'], $f['size']),
            array_slice($found, ($page - 1) * $this->perPage, $this->perPage));

        return ['files' => $files, 'page' => $page, 'pages' => $pages, 'total' => $total];
    }

    /**
     * Take one uploaded file (an entry of $_FILES) into the folder.
     *
     * @param array<string, mixed> $upload
     * @return array{file: array<string, mixed>}|array{error: string}
     */
    public function upload(array $upload): array
    {
        $error = (int) ($upload['error'] ?? UPLOAD_ERR_NO_FILE);
        if ($error === UPLOAD_ERR_INI_SIZE || $error === UPLOAD_ERR_FORM_SIZE) {
            return ['error' => 'The file is too large.'];
        }
        if ($error !== UPLOAD_ERR_OK || !is_string($upload['tmp_name'] ?? null) || !$this->isUploaded($upload['tmp_name'])) {
            return ['error' => 'No file arrived.'];
        }
        $size = (int) ($upload['size'] ?? 0);
        if ($size <= 0 || $size > $this->maxBytes) {
            return ['error' => 'The file is too large.'];
        }

        $name = $this->safeName((string) ($upload['name'] ?? ''));
        $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        if ($ext === '' || !in_array($ext, $this->extensions, true)) {
            return ['error' => 'That type of file is not allowed.'];
        }
        $isImage = in_array($ext, self::IMAGE_EXTENSIONS, true);
        // An image must really be one, not a script with a .jpg name.
        if ($isImage && @getimagesize($upload['tmp_name']) === false) {
            return ['error' => 'That file is not a readable image.'];
        }

        $final = $this->unusedName($name);
        if (!$this->move($upload['tmp_name'], $this->dir . DIRECTORY_SEPARATOR . $final)) {
            return ['error' => 'The file could not be saved.'];
        }
        @chmod($this->dir . DIRECTORY_SEPARATOR . $final, 0644);

        return ['file' => $this->describe($final, $isImage, $size)];
    }

    /**
     * A name made only of safe characters: letters, digits, dot, dash and
     * underscore, no leading dot, and no path at all.
     */
    public function safeName(string $original): string
    {
        $base = basename(str_replace('\\', '/', $original));
        $ext = strtolower(pathinfo($base, PATHINFO_EXTENSION));
        $stem = pathinfo($base, PATHINFO_FILENAME);
        // Accents off (É to E) where the intl extension can do it the same on
        // every platform; anything else outside ASCII becomes a dash below.
        if (class_exists('Normalizer')) {
            $stem = (string) preg_replace('/\p{Mn}+/u', '', (string) Normalizer::normalize($stem, Normalizer::FORM_D));
        }
        $stem = trim((string) preg_replace('/[^A-Za-z0-9_-]+/', '-', $stem), '-_');
        $stem = substr($stem, 0, 80) ?: 'file';
        $ext = (string) preg_replace('/[^a-z0-9]/', '', $ext);

        return $ext === '' ? $stem : $stem . '.' . $ext;
    }

    /** The name, or name-2, name-3...: an upload never replaces a file. */
    private function unusedName(string $name): string
    {
        $stem = pathinfo($name, PATHINFO_FILENAME);
        $ext = pathinfo($name, PATHINFO_EXTENSION);
        $candidate = $name;
        for ($n = 2; file_exists($this->dir . DIRECTORY_SEPARATOR . $candidate); $n++) {
            $candidate = $stem . '-' . $n . ($ext === '' ? '' : '.' . $ext);
        }

        return $candidate;
    }

    /** @return array<string, mixed> one file, as the plugin reads it */
    private function describe(string $entry, bool $isImage, int $size): array
    {
        return [
            'url' => $this->publicUrl . '/' . rawurlencode($entry),
            'name' => $entry,
            'isImage' => $isImage,
            'size' => $size,
        ];
    }

    /** Separate so a test can stand in for PHP's upload handling. */
    protected function isUploaded(string $tmp): bool
    {
        return is_uploaded_file($tmp);
    }

    protected function move(string $from, string $to): bool
    {
        return move_uploaded_file($from, $to);
    }
}
