import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import jQuery from 'jquery';

let $;

beforeAll(async () => {
  // Summernote checks which fonts are installed with a canvas as it loads;
  // jsdom has no canvas, so it gets one that measures every font the same.
  HTMLCanvasElement.prototype.getContext = () => ({
    font: '', textAlign: '', textBaseline: '', fillStyle: '',
    fillText() {}, clearRect() {}, measureText: () => ({ width: 10 }),
    getImageData: () => ({ data: [] }),
  });
  window.$ = window.jQuery = jQuery;
  $ = jQuery;
  await import('summernote/dist/summernote-lite.js');
  await import('../../src/summernote-ext-filemanager.js');
});

/** An ajax answer, as a jQuery promise. */
function answer(data) {
  return $.Deferred().resolve(data).promise();
}

function failure(status, json) {
  return $.Deferred().reject({ status: status, responseJSON: json }).promise();
}

const LIST = {
  files: [
    { url: '/uploads/reef.jpg', name: 'oyster-reef_2024.jpg', size: 2048 },
    { url: '/uploads/plan.pdf', name: 'plan.pdf', size: 3 * 1024 * 1024 },
  ],
  page: 1,
  pages: 1,
  total: 2,
};

let $note;
let ajax;

function editor(filemanager, extra) {
  $note = $('<div><p>hello</p></div>').appendTo(document.body);
  $note.summernote($.extend({
    toolbar: [['insert', ['filemanager']]],
    filemanager: $.extend({ url: '/fm' }, filemanager || {}),
  }, extra || {}));
  const context = $note.data('summernote');
  return { context, plugin: context.modules.filemanager };
}

function dialog() {
  return $('.note-filemanager-dialog');
}

beforeEach(() => {
  ajax = vi.spyOn($, 'ajax').mockImplementation(() => answer(LIST));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if ($note) {
    $note.summernote('destroy');
    $note.remove();
  }
  $('body').empty();
});

describe('the toolbar button', () => {
  it('is added with its tooltip and opens the dialog', async () => {
    const { plugin } = editor();
    const $btn = $note.next('.note-editor').find('.note-toolbar .note-btn');
    expect($btn.length).toBe(1);
    expect($btn.find('svg.note-filemanager-icon').length).toBe(1);
    expect($btn.attr('aria-label') || $btn.attr('title')).toBe('Browse files');

    $btn.trigger('click');
    await new Promise((r) => setTimeout(r, 20)); // jQuery runs promise callbacks later
    expect(ajax).toHaveBeenCalledTimes(1);
    expect(dialog().find('.note-filemanager-pick').length).toBe(2);
  });

  it('ignores a list that arrives after the editor is gone', async () => {
    const slow = $.Deferred();
    ajax.mockImplementation(() => slow.promise());
    const { plugin } = editor();
    plugin.show();
    $note.summernote('destroy');
    slow.resolve(LIST);
    await new Promise((r) => setTimeout(r, 20));
    expect(plugin.$dialog).toBe(null);
  });
});

describe('listing', () => {
  it('asks the url with the search, filter, page, params and headers', async () => {
    const { plugin } = editor({ params: { folder: 'news' }, headers: () => ({ 'X-CSRF-Token': 't0k' }) });
    await plugin.show();

    const req = ajax.mock.calls[0][0];
    expect(req.url).toBe('/fm');
    expect(req.type).toBe('GET');
    expect(req.dataType).toBe('json');
    expect(req.data).toEqual({ folder: 'news', q: '', filter: 'images', page: 1 });
    expect(req.headers).toEqual({ 'X-CSRF-Token': 't0k' });
  });

  it('tells a params function which request it is for', async () => {
    const params = vi.fn((kind) => ({ route: kind }));
    ajax.mockImplementation((req) => answer(req.type === 'POST' && req.processData === false ? { file: { url: '/u/a.png' } } : LIST));
    const { plugin } = editor({ params: params });
    await plugin.show();
    expect(ajax.mock.calls[0][0].data.route).toBe('list');
    await plugin.upload([new File(['x'], 'a.png')]);
    const up = ajax.mock.calls.find((c) => c[0].processData === false)[0];
    expect(up.data.get('route')).toBe('upload');
  });

  it('can ask by POST, and open on all files', async () => {
    const { plugin } = editor({ method: 'post', filter: 'all' });
    await plugin.show();
    expect(ajax.mock.calls[0][0].type).toBe('POST');
    expect(ajax.mock.calls[0][0].data.filter).toBe('all');
  });

  it('draws names as text, a thumbnail for an image and the extension for anything else', async () => {
    ajax.mockImplementation(() => answer({
      files: [
        { url: '/u/a.png', name: '<img src=x onerror=alert(1)>.png', thumb: '/u/thumbs/a.png', size: 500 },
        { url: '/u/b.docx', name: 'b.docx' },
      ],
    }));
    const { plugin } = editor();
    await plugin.show();

    const $picks = dialog().find('.note-filemanager-pick');
    expect($picks.eq(0).find('.note-filemanager-name').text()).toBe('<img src=x onerror=alert(1)>.png');
    expect(dialog().find('.note-filemanager-name img').length).toBe(0);
    expect($picks.eq(0).find('.note-filemanager-thumb img').attr('src')).toBe('/u/thumbs/a.png');
    expect($picks.eq(0).find('.note-filemanager-size').text()).toBe('500 B');
    expect($picks.eq(1).find('.note-filemanager-thumb img').length).toBe(0);
    expect($picks.eq(1).find('.note-filemanager-ext').text()).toBe('docx');
    expect($picks.eq(1).find('.note-filemanager-size').length).toBe(0);
  });

  it('says when there is nothing, and when a search matched nothing', async () => {
    ajax.mockImplementation(() => answer({ files: [] }));
    const { plugin } = editor();
    await plugin.show();
    expect(dialog().find('.note-filemanager-empty').text()).toBe('No files here yet. Drop one in, or use Upload.');

    dialog().find('.note-filemanager-search').val('reef');
    await plugin.load(1);
    expect(dialog().find('.note-filemanager-empty').text()).toBe('Nothing matches “reef”.');
  });

  it('says when the list could not load', async () => {
    ajax.mockImplementation(() => failure(500));
    const { plugin } = editor();
    await plugin.show().catch(() => {});
    expect(dialog().find('.note-filemanager-error').text()).toBe('Could not load files (500).');
  });

  it('pages, with the current page marked', async () => {
    ajax.mockImplementation((req) => answer({ files: LIST.files, page: req.data.page, pages: 9, total: 300 }));
    const { plugin } = editor();
    await plugin.show();

    const $current = dialog().find('.note-filemanager-page[aria-current="page"]');
    expect($current.text()).toBe('1');
    expect(dialog().find('.note-filemanager-count').text()).toBe('300 files');
    expect(dialog().find('.note-filemanager-page').first().prop('disabled')).toBe(true); // Previous

    dialog().find('.note-filemanager-page[data-page="3"]').trigger('click');
    expect(ajax.mock.calls[1][0].data.page).toBe(3);
  });

  it('drops an answer that arrives after a newer one', async () => {
    const slow = $.Deferred();
    ajax.mockImplementationOnce(() => slow.promise())
      .mockImplementationOnce(() => answer({ files: [{ url: '/u/new.png' }] }));
    const { plugin } = editor();
    plugin.show();
    await plugin.load(1);
    slow.resolve({ files: [{ url: '/u/old.png' }] });

    expect(dialog().find('.note-filemanager-name').text()).toBe('new.png');
  });

  it('searches once typing pauses, and again when the filter changes', () => {
    vi.useFakeTimers();
    const { plugin } = editor();
    plugin.show();
    ajax.mockClear();

    const $search = dialog().find('.note-filemanager-search');
    $search.val('o').trigger('input');
    $search.val('oy').trigger('input');
    $search.val('oys').trigger('input');
    expect(ajax).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(ajax).toHaveBeenCalledTimes(1);
    expect(ajax.mock.calls[0][0].data.q).toBe('oys');

    dialog().find('.note-filemanager-filter').val('all').trigger('change');
    expect(ajax.mock.calls[1][0].data).toMatchObject({ q: 'oys', filter: 'all', page: 1 });
  });

  it('can take its list from a function instead of a url', async () => {
    const list = vi.fn(() => Promise.resolve({ files: [{ url: 'https://cdn.example/x.webp' }] }));
    const { plugin } = editor({ url: null, list: list, upload: false });
    await plugin.show();

    expect(ajax).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledWith({ q: '', filter: 'images', page: 1 });
    expect(dialog().find('.note-filemanager-name').text()).toBe('x.webp');
  });
});

describe('inserting', () => {
  it('puts an image in at the saved cursor, with alt text from its name', async () => {
    const { context, plugin } = editor();
    await plugin.show();
    const calls = [];
    vi.spyOn(context, 'invoke').mockImplementation((name, ...args) => { calls.push([name, ...args]); });

    dialog().find('.note-filemanager-pick').eq(0).trigger('click');

    expect(calls[0][0]).toBe('editor.restoreRange');
    expect(calls[1][0]).toBe('editor.insertImage');
    expect(calls[1][1]).toBe('/uploads/reef.jpg');
    const $img = $('<img>');
    calls[1][2]($img);
    expect($img.attr('alt')).toBe('oyster reef 2024');
    expect($img.attr('data-filename')).toBe('oyster-reef_2024.jpg');
  });

  it('lets the site write the alt text', async () => {
    const { context, plugin } = editor({ alt: (f) => 'Photo: ' + f.name });
    await plugin.show();
    let callback;
    vi.spyOn(context, 'invoke').mockImplementation((name, url, cb) => { if (name === 'editor.insertImage') { callback = cb; } });
    dialog().find('.note-filemanager-pick').eq(0).trigger('click');
    const $img = $('<img>');
    callback($img);
    expect($img.attr('alt')).toBe('Photo: oyster-reef_2024.jpg');
  });

  it('puts anything else in as a link', async () => {
    const { context, plugin } = editor();
    await plugin.show();
    const calls = [];
    vi.spyOn(context, 'invoke').mockImplementation((name, ...args) => { calls.push([name, ...args]); });

    dialog().find('.note-filemanager-pick').eq(1).trigger('click');

    expect(calls[1]).toEqual(['editor.createLink', { text: 'plan.pdf', url: '/uploads/plan.pdf', isNewWindow: true }]);
  });
});

describe('uploading', () => {
  it('sends one file at a time with the params, reports the ones refused, then reloads', async () => {
    const sent = [];
    ajax.mockImplementation((req) => {
      if (req.type !== 'POST') {
        return answer(LIST);
      }
      sent.push(req);
      const name = req.data.get('file').name;
      if (name === 'bad.exe') {
        return failure(422, { error: 'That type of file is not allowed.' });
      }
      if (name === 'odd.png') {
        return answer({ error: 'Not an image.' });
      }
      return answer({ file: { url: '/u/' + name } });
    });
    const { plugin } = editor({ uploadUrl: '/fm/upload', params: { folder: 'news' } });
    await plugin.show();

    const files = ['a.png', 'bad.exe', 'odd.png'].map((n) => new File(['x'], n));
    const failed = await plugin.upload(files);

    expect(sent.map((r) => r.data.get('file').name)).toEqual(['a.png', 'bad.exe', 'odd.png']);
    expect(sent[0].url).toBe('/fm/upload');
    expect(sent[0].processData).toBe(false);
    expect(sent[0].data.get('folder')).toBe('news');
    expect(sent[0].data.get('filter')).toBe('images');
    expect(failed).toEqual(['bad.exe (That type of file is not allowed.)', 'odd.png (Not an image.)']);
    expect(dialog().find('.note-filemanager-error').text())
      .toBe('Could not upload: bad.exe (That type of file is not allowed.), odd.png (Not an image.)');
    expect(ajax.mock.calls.at(-1)[0].type).toBe('GET');
  });

  it('can be switched off', async () => {
    editor({ upload: false });
    expect(dialog().find('.note-filemanager-upload, .note-filemanager-file').length).toBe(0);
  });
});

describe('language', () => {
  it('takes its words from the editor language', async () => {
    $.summernote.lang['fr-FR'] = $.extend(true, {}, $.summernote.lang['en-US'], {
      filemanager: { title: 'Fichiers', upload: 'Téléverser…' },
    });
    editor({}, { lang: 'fr-FR' });
    expect(dialog().find('.note-filemanager-upload').text()).toBe('Téléverser…');
    expect(dialog().text()).toContain('Fichiers');
  });
});

describe('helpers', () => {
  it('reads a file from the little a server sends', () => {
    const fm = $.summernote.filemanager;
    expect(fm.normalizeFile({ url: '/a/Reef%20map.PNG?v=2' })).toMatchObject({ name: 'Reef map.PNG', isImage: true, thumb: '/a/Reef%20map.PNG?v=2', ext: 'png' });
    expect(fm.normalizeFile({ url: '/a/x', name: 'x.jpg', isImage: false })).toMatchObject({ isImage: false, thumb: null });
    expect(fm.normalizeFile({ name: 'no url' })).toBe(null);
    expect(fm.normalizeList({ files: [{}, { url: '/a.pdf' }], page: 7, pages: 3 }, 1)).toMatchObject({ page: 3, pages: 3, total: null });
  });

  it('writes sizes and alt text', () => {
    const fm = $.summernote.filemanager;
    expect([fm.humanSize(10), fm.humanSize(2048), fm.humanSize(5 * 1024 * 1024), fm.humanSize(null)]).toEqual(['10 B', '2 KB', '5.0 MB', '']);
    expect(fm.altFromName('bay_grass--survey.final.jpeg')).toBe('bay grass survey.final');
  });
});
