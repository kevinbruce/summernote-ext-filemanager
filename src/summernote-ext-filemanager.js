/**
 * summernote-ext-filemanager
 *
 * Browse the files already on your server from inside Summernote, upload
 * more, and insert one: an image as an <img>, anything else as a link.
 *
 * Summernote can upload a picture, but it has no idea of a library: nothing
 * already on the server can be picked again. This plugin adds that as one
 * toolbar button and a dialog, talking to a small endpoint you provide
 * (see README.md for the protocol, and examples/php for a reference one).
 *
 *     $('#editor').summernote({
 *       toolbar: [['insert', ['link', 'filemanager']]],
 *       filemanager: { url: '/filemanager.php' }
 *     });
 *
 * Depends on jQuery and Summernote (lite, bs3, bs4 or bs5). MIT licensed.
 * https://github.com/kevinbruce/summernote-ext-filemanager
 */
(function (factory) {
  if (typeof define === 'function' && define.amd) {
    define(['jquery'], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('jquery'));
  } else {
    factory(window.jQuery);
  }
}(function ($) {
  'use strict';

  if (!$ || !$.summernote) {
    return;
  }

  var IMAGE = /\.(apng|avif|gif|jpe?g|png|svg|webp)$/i;

  // An icon of its own: Summernote's icon font has nothing for a library,
  // and the plugin should not depend on Font Awesome or anything else.
  var ICON = '<svg class="note-filemanager-icon" viewBox="0 0 16 16" width="1em" height="1em" ' +
    'aria-hidden="true" focusable="false"><path fill="currentColor" d="M2 3.5A1.5 1.5 0 0 1 3.5 2h3l1.5 ' +
    '1.5h4.5A1.5 1.5 0 0 1 14 5v7.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-9zm1.5 0V12.5h9V5H7.4L5.9 ' +
    '3.5H3.5zm1.5 7.5 2-2.5 1.5 1.75L10 8l2 2.5H5z"/></svg>';

  $.extend(true, $.summernote.lang, {
    'en-US': {
      filemanager: {
        tooltip: 'Browse files',
        title: 'Files',
        search: 'Search by file name…',
        images: 'Images',
        all: 'All files',
        upload: 'Upload…',
        drop: 'Drop files to upload',
        loading: 'Loading…',
        empty: 'No files here yet.',
        emptyUpload: 'No files here yet. Drop one in, or use Upload.',
        noMatch: 'Nothing matches “{q}”.',
        loadFailed: 'Could not load files ({status}).',
        uploading: 'Uploading {n} of {total}: {name}',
        uploadFailed: 'Could not upload: {names}',
        previous: 'Previous',
        next: 'Next',
        pageOf: 'Page {page} of {pages}',
        count: '{total} files',
        countOne: '1 file'
      }
    }
  });

  var DEFAULTS = {
    url: null,           // the endpoint: GET lists, POST uploads
    uploadUrl: null,     // where uploads go, if not url
    method: 'GET',       // how the list is asked for
    params: {},          // sent with every request (object, or a function returning one)
    headers: {},         // sent with every request, e.g. a CSRF token (object or function)
    upload: true,        // offer uploading
    filter: 'images',    // the filter the dialog opens on: 'images' or 'all'
    list: null,          // function (criteria) -> Promise<{files, page, pages, total}>, instead of url
    uploadFile: null,    // function (file, criteria) -> Promise, instead of url
    alt: null,           // function (file) -> alt text for an inserted image
    icon: ICON,          // the toolbar button's contents (HTML)
    linkNewWindow: true  // a non-image file opens in a new tab
  };

  function format(text, values) {
    return String(text).replace(/\{(\w+)\}/g, function (m, key) {
      return values[key] === undefined ? m : String(values[key]);
    });
  }

  function value(v) {
    return typeof v === 'function' ? v() : v;
  }

  /** The name without its extension, dashes and underscores as spaces. */
  function altFromName(name) {
    return String(name || '').replace(/\.[^.\/]+$/, '').replace(/[-_]+/g, ' ').trim();
  }

  function humanSize(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n < 0 || bytes === null || bytes === '') {
      return '';
    }
    if (n < 1024) {
      return n + ' B';
    }
    if (n < 1024 * 1024) {
      return Math.round(n / 1024) + ' KB';
    }
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /** One file from the server, in the shape the dialog draws. */
  function normalizeFile(f) {
    if (!f || typeof f !== 'object' || !f.url) {
      return null;
    }
    var url = String(f.url);
    var name = f.name ? String(f.name) : decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() || url);
    var isImage = typeof f.isImage === 'boolean' ? f.isImage : IMAGE.test(name) || IMAGE.test(url.split(/[?#]/)[0]);
    return {
      url: url,
      name: name,
      isImage: isImage,
      thumb: f.thumb ? String(f.thumb) : (isImage ? url : null),
      size: f.size === undefined ? null : f.size,
      ext: (name.match(/\.([^.\/]+)$/) || [null, ''])[1].toLowerCase()
    };
  }

  /** The list answer, whatever a server left out. */
  function normalizeList(data, page) {
    data = data || {};
    var files = $.map($.isArray(data.files) ? data.files : [], normalizeFile);
    var pages = Math.max(1, parseInt(data.pages, 10) || 1);
    return {
      files: files,
      page: Math.min(Math.max(1, parseInt(data.page, 10) || page || 1), pages),
      pages: pages,
      total: data.total === undefined ? null : parseInt(data.total, 10)
    };
  }

  /** A short run of page numbers around the current one. */
  function pageWindow(page, pages, span) {
    var out = [];
    for (var p = Math.max(1, page - span); p <= Math.min(pages, page + span); p++) {
      out.push(p);
    }
    return out;
  }

  $.extend($.summernote.plugins, {
    filemanager: function (context) {
      var self = this;
      var ui = $.summernote.ui;
      var options = context.options;
      var settings = $.extend({}, DEFAULTS, options.filemanager || {});
      var lang = $.extend({}, $.summernote.lang['en-US'].filemanager,
        (options.langInfo && options.langInfo.filemanager) || {});

      var searchTimer = null;
      var request = 0;       // the latest load; an older answer arriving late is dropped
      var state = { page: 1 };

      context.memo('button.filemanager', function () {
        return ui.button({
          contents: settings.icon,
          tooltip: lang.tooltip,
          click: function () {
            // The dialog takes focus out of the editable. saveRange and
            // restoreRange keep the insertion point, as Summernote's own
            // link and image dialogs do.
            context.invoke('editor.saveRange');
            self.show();
          }
        }).render();
      });

      this.initialize = function () {
        var $container = options.dialogsInBody ? $(document.body) : context.layoutInfo.editor;

        var $body = $('<div class="note-filemanager">');
        var $bar = $('<div class="note-filemanager-bar">').appendTo($body);
        $('<input type="search" class="note-filemanager-search form-control note-input" autocomplete="off">')
          .attr({ placeholder: lang.search, 'aria-label': lang.search }).appendTo($bar);
        var $filter = $('<select class="note-filemanager-filter form-control note-input">')
          .attr('aria-label', lang.images + ' / ' + lang.all).appendTo($bar);
        $('<option value="images">').text(lang.images).appendTo($filter);
        $('<option value="all">').text(lang.all).appendTo($filter);
        // An attribute, not .val(): the dialog is built from this markup as a string.
        $filter.find('option[value="' + (settings.filter === 'all' ? 'all' : 'images') + '"]').attr('selected', 'selected');
        if (this.canUpload()) {
          $('<button type="button" class="note-filemanager-upload note-btn btn btn-default btn-sm">')
            .text(lang.upload).appendTo($bar);
          $('<input type="file" class="note-filemanager-file" multiple hidden>').appendTo($bar);
        }
        $('<div class="note-filemanager-status" role="status" aria-live="polite">').appendTo($body);
        $('<div class="note-filemanager-results">').appendTo($body);
        $('<div class="note-filemanager-veil" aria-hidden="true">').append($('<span>').text(lang.drop)).appendTo($body);

        this.$dialog = ui.dialog({
          className: 'note-filemanager-dialog',
          title: lang.title,
          fade: options.dialogsFade,
          body: $body.prop('outerHTML'),
          footer: ''
        }).render().appendTo($container);

        this.bind();
      };

      this.destroy = function () {
        clearTimeout(searchTimer);
        request++;
        if (this.$dialog) {
          ui.hideDialog(this.$dialog);
          this.$dialog.remove();
          this.$dialog = null;
        }
      };

      this.canUpload = function () {
        return !!settings.upload && !!(settings.uploadFile || settings.uploadUrl || settings.url);
      };

      this.bind = function () {
        var $dialog = this.$dialog;

        // Delegated: the grid is redrawn on every search, filter, page and upload.
        $dialog.on('click', '.note-filemanager-pick', function () {
          self.insert($(this).data('file'));
        });

        $dialog.on('click', '.note-filemanager-page', function () {
          var p = parseInt($(this).data('page'), 10);
          if (p > 0) {
            self.load(p);
          }
        });

        $dialog.on('input', '.note-filemanager-search', function () {
          clearTimeout(searchTimer);
          searchTimer = setTimeout(function () { self.load(1); }, 250);
        });

        $dialog.on('change', '.note-filemanager-filter', function () {
          self.load(1);
        });

        if (!this.canUpload()) {
          return;
        }

        $dialog.on('click', '.note-filemanager-upload', function () {
          $dialog.find('.note-filemanager-file').trigger('click');
        });

        $dialog.on('change', '.note-filemanager-file', function () {
          // Copied before the reset: input.files is live, and clearing the
          // input would empty the list being uploaded.
          var files = Array.prototype.slice.call(this.files || []);
          this.value = '';
          self.upload(files);
        });

        // dragenter and dragover must both be cancelled, or the browser
        // navigates to the dropped file and the editor is lost.
        var depth = 0;
        $dialog.on('dragenter dragover', function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (e.type === 'dragenter') {
            depth++;
          }
          $dialog.addClass('note-filemanager-dragging');
        });
        $dialog.on('dragleave', function (e) {
          e.preventDefault();
          e.stopPropagation();
          depth = Math.max(0, depth - 1);
          if (!depth) {
            $dialog.removeClass('note-filemanager-dragging');
          }
        });
        $dialog.on('drop', function (e) {
          e.preventDefault();
          e.stopPropagation();
          depth = 0;
          $dialog.removeClass('note-filemanager-dragging');
          var dt = e.originalEvent && e.originalEvent.dataTransfer;
          if (dt && dt.files && dt.files.length) {
            self.upload(dt.files);
          }
        });
      };

      /** What the dialog is showing: the search, the filter and the page. */
      this.criteria = function (page) {
        var $dialog = this.$dialog;
        return {
          q: $.trim($dialog.find('.note-filemanager-search').val() || ''),
          filter: $dialog.find('.note-filemanager-filter').val() === 'all' ? 'all' : 'images',
          page: page || 1
        };
      };

      /** A request to the endpoint, with the site's params and headers. */
      this.ajax = function (url, type, data, isUpload) {
        var extra = value(settings.params) || {};
        var req = {
          url: url,
          type: type,
          dataType: 'json',
          cache: false,
          headers: value(settings.headers) || {}
        };
        if (isUpload) {
          $.each(extra, function (k, v) { data.append(k, v); });
          req.data = data;
          req.processData = false;
          req.contentType = false;
        } else {
          req.data = $.extend({}, extra, data);
        }
        return $.ajax(req);
      };

      this.fetchList = function (criteria) {
        if (settings.list) {
          return $.when(settings.list(criteria));
        }
        return this.ajax(settings.url, String(settings.method || 'GET').toUpperCase(), criteria, false);
      };

      this.sendFile = function (file, criteria) {
        if (settings.uploadFile) {
          return $.when(settings.uploadFile(file, criteria));
        }
        var form = new FormData();
        form.append('file', file);
        $.each(criteria, function (k, v) { form.append(k, v); });
        return this.ajax(settings.uploadUrl || settings.url, 'POST', form, true);
      };

      /** @param {number} page 1-based */
      this.load = function (page) {
        var criteria = this.criteria(page);
        var mine = ++request;
        var $results = this.$dialog.find('.note-filemanager-results');

        this.status(lang.loading);

        // An answer is dropped if a newer load has started, or if the editor
        // was destroyed while this one was on its way.
        return this.fetchList(criteria).then(function (data) {
          if (mine !== request || !self.$dialog) {
            return;
          }
          var list = normalizeList(data, criteria.page);
          state.page = list.page;
          self.status('');
          $results.empty().append(self.render(list, criteria));
        }, function (xhr) {
          if (mine !== request || !self.$dialog) {
            return;
          }
          self.status('');
          $results.empty().append($('<p class="note-filemanager-empty note-filemanager-error">')
            .text(format(lang.loadFailed, { status: (xhr && xhr.status) || '?' })));
        });
      };

      this.status = function (text) {
        if (!this.$dialog) {
          return;
        }
        this.$dialog.find('.note-filemanager-status').text(text || '');
      };

      /** The grid and its pager, built as elements: nothing from the server is parsed as HTML. */
      this.render = function (list, criteria) {
        var $out = $('<div>');

        if (!list.files.length) {
          var text = criteria.q ? format(lang.noMatch, { q: criteria.q }) : (this.canUpload() ? lang.emptyUpload : lang.empty);
          return $out.append($('<p class="note-filemanager-empty">').text(text)).children();
        }

        var $grid = $('<ul class="note-filemanager-grid">').appendTo($out);
        $.each(list.files, function (i, file) {
          var $pick = $('<button type="button" class="note-filemanager-pick">')
            .attr('title', file.name + (file.size !== null ? ' (' + humanSize(file.size) + ')' : ''))
            .data('file', file);
          var $thumb = $('<span class="note-filemanager-thumb">').appendTo($pick);
          if (file.thumb) {
            $('<img alt="" loading="lazy">').attr('src', file.thumb)
              .on('error', function () { $thumb.addClass('note-filemanager-missing'); $(this).remove(); })
              .appendTo($thumb);
          } else {
            $('<span class="note-filemanager-ext">').text(file.ext || '?').appendTo($thumb);
          }
          $('<span class="note-filemanager-name">').text(file.name).appendTo($pick);
          if (file.size !== null) {
            $('<span class="note-filemanager-size">').text(humanSize(file.size)).appendTo($pick);
          }
          $('<li class="note-filemanager-item">').append($pick).appendTo($grid);
        });

        var $foot = $('<div class="note-filemanager-foot">').appendTo($out);
        if (list.total !== null && !isNaN(list.total)) {
          $('<span class="note-filemanager-count">')
            .text(list.total === 1 ? lang.countOne : format(lang.count, { total: list.total })).appendTo($foot);
        }
        if (list.pages > 1) {
          var $pager = $('<nav class="note-filemanager-pager">').attr('aria-label', format(lang.pageOf, list)).appendTo($foot);
          var pageButton = function (p, label, current) {
            return $('<button type="button" class="note-filemanager-page">')
              .attr('data-page', p).text(label)
              .prop('disabled', current || p < 1 || p > list.pages)
              .attr('aria-current', current ? 'page' : null)
              .appendTo($pager);
          };
          pageButton(list.page - 1, lang.previous, false);
          $.each(pageWindow(list.page, list.pages, 2), function (i, p) {
            pageButton(p, String(p), p === list.page);
          });
          pageButton(list.page + 1, lang.next, false);
        }

        return $out.children();
      };

      /**
       * One file at a time, in order: one refused file does not take the
       * batch with it, and the grid is redrawn once at the end.
       */
      this.upload = function (files) {
        var list = Array.prototype.slice.call(files || []);
        var total = list.length;
        var failed = [];
        var n = 0;
        var deferred = $.Deferred();

        if (!total) {
          return deferred.resolve().promise();
        }

        var next = function () {
          if (!self.$dialog) {
            deferred.resolve(failed); // the editor went away mid-upload
            return;
          }
          if (!list.length) {
            self.load(1).always(function () {
              if (failed.length && self.$dialog) {
                self.$dialog.find('.note-filemanager-results').prepend(
                  $('<p class="note-filemanager-empty note-filemanager-error">')
                    .text(format(lang.uploadFailed, { names: failed.join(', ') })));
              }
              deferred.resolve(failed);
            });
            return;
          }
          var file = list.shift();
          n++;
          self.status(format(lang.uploading, { n: n, total: total, name: file.name }));
          self.sendFile(file, self.criteria(1)).then(function (answer) {
            if (answer && answer.error) {
              failed.push(file.name + ' (' + answer.error + ')');
            }
          }, function (xhr) {
            var why = xhr && xhr.responseJSON && xhr.responseJSON.error;
            failed.push(why ? file.name + ' (' + why + ')' : file.name);
          }).always(next);
        };

        next();
        return deferred.promise();
      };

      this.show = function () {
        ui.showDialog(this.$dialog);
        // Popovers close on this; showDialog() fires nothing itself, so an
        // image or table popover would otherwise float over the dialog.
        context.triggerEvent('dialog.shown');
        var $dialog = this.$dialog;
        // After the open animation, or Bootstrap takes the focus back.
        setTimeout(function () { $dialog.find('.note-filemanager-search').trigger('focus'); }, 200);
        return this.load(1);
      };

      this.insert = function (file) {
        if (!file) {
          return;
        }
        ui.hideDialog(this.$dialog);
        // insertImage and createLink act on the saved range, so it goes back first.
        context.invoke('editor.restoreRange');

        if (file.isImage) {
          var alt = settings.alt ? settings.alt(file) : altFromName(file.name);
          // The callback form: a string second argument would only become
          // data-filename, and passing a function opts out of Summernote's
          // width cap, so that is done here.
          context.invoke('editor.insertImage', file.url, function ($image) {
            $image.attr('alt', alt);
            $image.attr('data-filename', file.name);
            var width = context.layoutInfo.editable.width();
            if (width && $image.width() > width) {
              $image.css('width', width);
            }
          });
        } else {
          context.invoke('editor.createLink', {
            text: file.name,
            url: file.url,
            isNewWindow: !!settings.linkNewWindow
          });
        }
      };
    }
  });

  // For tests and for anyone extending the plugin.
  $.summernote.filemanager = {
    defaults: DEFAULTS,
    normalizeFile: normalizeFile,
    normalizeList: normalizeList,
    altFromName: altFromName,
    humanSize: humanSize
  };
}));
