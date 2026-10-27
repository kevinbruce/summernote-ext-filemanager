# summernote-ext-filemanager

A file library for [Summernote](https://summernote.org). Browse the files
already on your server, upload more, and insert one: an image as an `<img>`
with alt text, anything else as a link.

Summernote can upload a picture, but it has no library: nothing already on the
server can be picked again. This adds one toolbar button and a dialog with
search, an images/all filter, paging, drag-and-drop upload and thumbnails. It
talks to a small endpoint you provide; a reference one in PHP is included.

- Works with Summernote lite, bs3, bs4 and bs5 (0.8.18 and later), and jQuery 3.
- No build step and no other dependencies: one script, one stylesheet.
- Nothing the server sends is parsed as HTML.
- Translatable through Summernote's own `lang` files.

## Install

```bash
npm install summernote-ext-filemanager
```

or from a CDN:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/summernote-ext-filemanager@0.1/src/summernote-ext-filemanager.css">
<script src="https://cdn.jsdelivr.net/npm/summernote-ext-filemanager@0.1/src/summernote-ext-filemanager.js"></script>
```

Load the script after Summernote, then add `filemanager` to a toolbar group:

```js
$('#editor').summernote({
  toolbar: [
    ['insert', ['link', 'filemanager']]
  ],
  filemanager: {
    url: '/filemanager.php'
  }
});
```

## Options

All under `filemanager` in Summernote's options.

| Option | Default | What it does |
|---|---|---|
| `url` | `null` | The endpoint. `GET` lists files, `POST` uploads one. |
| `uploadUrl` | `url` | Where uploads go, if somewhere else. |
| `method` | `'GET'` | How the list is asked for (`'POST'` for a framework that routes on POST). |
| `params` | `{}` | Extra fields sent with every request. An object, or a function returning one. |
| `headers` | `{}` | Extra headers sent with every request, e.g. a CSRF token. An object or a function. |
| `upload` | `true` | Offer uploading (the button and drag-and-drop). |
| `filter` | `'images'` | What the dialog opens on: `'images'` or `'all'`. |
| `list` | `null` | `function (criteria)` returning a promise of a list, instead of `url`. |
| `uploadFile` | `null` | `function (file, criteria)` returning a promise, instead of `url`. |
| `alt` | name without extension | `function (file)` returning an inserted image's alt text. |
| `icon` | a folder icon | The toolbar button's contents, as HTML. |
| `linkNewWindow` | `true` | Whether a non-image file's link opens in a new tab. |

A CSRF token, for example:

```js
filemanager: {
  url: '/files',
  headers: () => ({ 'X-CSRF-Token': document.querySelector('meta[name=csrf-token]').content })
}
```

## The endpoint

### Listing: `GET url?q=&filter=&page=`

| Parameter | Meaning |
|---|---|
| `q` | What was typed in the search box, possibly empty. |
| `filter` | `images` or `all`. |
| `page` | The page wanted, from 1. |

Plus anything in `params`. Answer with JSON:

```json
{
  "files": [
    { "url": "/uploads/reef.jpg", "name": "reef.jpg", "isImage": true, "thumb": "/uploads/thumbs/reef.jpg", "size": 48213 }
  ],
  "page": 1,
  "pages": 3,
  "total": 97
}
```

Only `url` is required for a file. `name` defaults to the last part of the URL,
`isImage` is guessed from the extension, `thumb` defaults to the image itself,
and `size` (bytes) is shown when given. `page`, `pages` and `total` drive the
pager and the count; leave them out for a single page.

Sort however suits your files; newest first is what people usually want, since
the file somebody just uploaded is the one they are looking for.

### Uploading: `POST uploadUrl`

`multipart/form-data` with the file as `file`, plus `q`, `filter` and `page`
(the dialog's state) and anything in `params`. One file per request: the
dialog sends a batch one at a time, so one refused file does not stop the rest.

Answer `2xx` with `{ "file": { … } }` on success, or `{ "error": "Why it was refused." }`,
either with a `4xx` status or `2xx`. The message is shown to the person
uploading, next to the file's name.

## The reference backend (PHP)

`examples/php/FileLibrary.php` lists and receives files for one folder, and
`examples/php/filemanager.php` is the endpoint around it. PHP 8.1 or later.

```bash
npm run demo     # php -S localhost:8080
# open http://localhost:8080/examples/
```

Copy both into your site and change three things in `filemanager.php`:

1. **Who may use it.** `may_use_library()` only answers under PHP's built-in
   development server, so a copy on a real site refuses everyone until you
   replace it with your sign-in check.
2. **Where the files are**: `LIBRARY_DIR` and `LIBRARY_URL`.
3. **That the folder cannot run anything** (below).

## Security: what any endpoint must do

A file endpoint is the easiest way to give a stranger your server. Whatever you
build or copy, check these:

- **Check who is asking** on every request, list and upload alike.
- **Never take a path from the request.** The folder is fixed in your code; a
  name from the upload is rebuilt from safe characters (`FileLibrary::safeName()`),
  so `../../index.php` arrives as `index.php` in your folder, or is refused.
- **Allow extensions, don't block them.** A list of what may be uploaded, with
  `.php`, `.phtml`, `.html` and `.svg` not on it. SVG can carry script, which
  is why the reference backend leaves it out.
- **Check that an image is one** (`getimagesize()`), not a script with a
  `.jpg` name.
- **Never overwrite**: a second `reef.jpg` becomes `reef-2.jpg`.
- **Refuse cross-site uploads.** A form on another site can post here with your
  visitor's cookies. Require a CSRF token (send it with `headers`) or, at the
  least, the `X-Requested-With: XMLHttpRequest` header jQuery adds, which a
  plain cross-site form cannot set. The reference endpoint checks the header.
- **Serve the folder as static files only.**

  Apache, in the uploads folder's `.htaccess`:

  ```apache
  Options -ExecCGI -Indexes
  RemoveHandler .php .phtml .php3 .php4 .php5 .php7 .phar
  RemoveType .php .phtml .php3 .php4 .php5 .php7 .phar
  <FilesMatch "\.(php|phtml|phar|html?|svg)$">
    Require all denied
  </FilesMatch>
  ```

  nginx:

  ```nginx
  location /uploads/ {
    location ~ \.(php|phtml|phar)$ { deny all; }
  }
  ```

## Translating

The words are in `$.summernote.lang['en-US'].filemanager`. Add a
`filemanager` block to your language and pass `lang` as usual:

```js
$.extend(true, $.summernote.lang, {
  'fr-FR': { filemanager: { tooltip: 'Parcourir les fichiers', title: 'Fichiers', upload: 'Téléverser…' } }
});
```

Anything left out falls back to English. The keys are in the source.

## Styling

Every class is `note-filemanager-` prefixed. Colors are custom properties on
`.note-filemanager-dialog`:

```css
.note-filemanager-dialog { --note-fm-accent: #006ea0; }
```

## Tests

```bash
npm test         # vitest (jsdom) for the plugin, plain php for the backend
```

## License

MIT © Kevin Bruce. Built for, and released with the permission of, Maryland Sea Grant.
