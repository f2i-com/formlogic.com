/*
 * The FormLogic Backups page. It runs in OAIY Desktop's sandboxed plugin frame, with no network and no storage:
 * everything goes through `window.PluginHost.command` to the plugin.
 *
 * What needs the person's say-so happens in a window of the plugin's own, not here: a command starts a job, this page
 * waits on the job, and the person answers the window. The twelve words only ever appear in that window. Names from
 * FormLogic go on the page as text, never as markup.
 */
(function () {
  'use strict';

  var HOST = window.PluginHost;
  if (!HOST) {
    document.body.textContent = 'Open this page in OAIY Desktop.';
    return;
  }

  var PAGE = 100;
  var MOST_AT_ONCE = 500;
  var NOTHING_CHANGED = 'Nothing was changed.';
  var status = null;
  var shown = PAGE;
  var busy = false;

  function $(id) { return document.getElementById(id); }

  function show(id, yes) { $(id).hidden = !yes; }

  function element(tag, className, text) {
    var made = document.createElement(tag);
    if (className) made.className = className;
    if (text !== undefined) made.textContent = text;
    return made;
  }

  function say(kind, text) {
    var line = $('fb-said');
    line.hidden = !text;
    line.className = 'fb-said' + (kind ? ' is-' + kind : '');
    line.textContent = text || '';
  }

  function words(error) {
    var message = error && error.message ? error.message : String(error);
    if (/connector is not available|not started yet|not running/i.test(message)) {
      return 'The plugin is not running. On the Plugins page, start it. If OAIY asks you to trust it first, as it does for a new version, trust it and then start it.';
    }
    return message;
  }

  function call(name, payload) {
    return HOST.command(name, payload === undefined ? {} : payload);
  }

  function pause(ms) {
    return new Promise(function (done) { setTimeout(done, ms); });
  }

  /** Waits for a job, as long as the person takes to answer its window. */
  function finished(started, step) {
    function look() {
      return call('jobs.get', { id: started.jobId }).then(function (job) {
        if (job.state === 'done') return job.result;
        if (job.state === 'failed') throw new Error(job.message || 'That did not work.');
        if (job.message && step) step(job.message);
        return pause(700).then(look);
      });
    }
    return look();
  }

  /** Runs a job from a button: one at a time, and whatever it says is said on the page. */
  function act(name, payload, opening, closing) {
    if (busy) return Promise.resolve();
    busy = true;
    paint();
    say('', opening);
    return call(name, payload)
      .then(function (started) { return finished(started, function (text) { say('', text); }); })
      .then(function (result) {
        say('good', typeof closing === 'function' ? closing(result) : closing);
        return result;
      })
      .catch(function (error) {
        var text = words(error);
        say(text === NOTHING_CHANGED ? '' : 'bad', text);
      })
      .then(function () {
        busy = false;
        return refresh();
      });
  }

  function when(iso) {
    var date = new Date(iso);
    return isNaN(date.getTime()) ? String(iso) : date.toLocaleString();
  }

  function size(bytes) {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }

  function paint() {
    var running = busy || (status && status.running);
    var approved = !!(status && status.approved);
    var hasKey = !!(status && status.hasKey);
    $('fb-run-all').disabled = running || !approved || !hasKey;
    $('fb-sources-refresh').disabled = running || !approved;
    Array.prototype.forEach.call(document.querySelectorAll('[data-action]'), function (button) {
      button.disabled = running || (button.dataset.action === 'run' && !(approved && hasKey));
    });
    if (!status) return;
    var state = $('fb-state');
    var ready = status.state === 'ready' || status.state === 'running';
    state.className = 'fb-pill ' + (ready ? 'is-good' : 'is-warn');
    state.querySelector('b').textContent = status.detail;
  }

  function button(text, action, className) {
    var made = element('button', 'fb-button' + (className ? ' ' + className : ''), text);
    made.type = 'button';
    made.dataset.action = action;
    return made;
  }

  function renderSources(sources) {
    var list = $('fb-sources');
    list.textContent = '';
    var items = [];
    (sources.apps || []).forEach(function (app) {
      items.push({ kind: 'app', id: app.id, name: app.name, note: app.softn ? 'SoftN app' : 'App' });
    });
    (sources.forms || []).forEach(function (form) {
      if (!form.inApp) items.push({ kind: 'form', id: form.id, name: form.title, note: form.private ? 'Private form' : 'Form' });
    });
    show('fb-sources-empty', items.length === 0);
    if (items.length === 0) $('fb-sources-empty').textContent = 'This account has no apps or forms yet.';
    items.forEach(function (item) {
      var row = element('li');
      var about = element('div', 'fb-item', item.name);
      about.appendChild(element('small', '', item.note));
      row.appendChild(about);
      var run = button('Back up', 'run');
      run.addEventListener('click', function () {
        act('backup.run', { only: [{ kind: item.kind, id: item.id, name: item.name }] }, 'Backing up…', ranWords);
      });
      row.appendChild(run);
      list.appendChild(row);
    });
    paint();
  }

  function loadSources() {
    if (!status || !status.approved) return Promise.resolve();
    return call('sources.list')
      .then(function (started) { return finished(started); })
      .then(renderSources)
      .catch(function (error) { say('bad', words(error)); });
  }

  function ranWords(outcome) {
    var text = outcome.saved + (outcome.saved === 1 ? ' backup saved.' : ' backups saved.');
    if (outcome.failedTotal) text += ' ' + outcome.failedTotal + ' could not be saved: see below.';
    if (outcome.stopped) text = outcome.stopped;
    return text;
  }

  function renderBackup(backup) {
    var row = element('li');
    var about = element('div', 'fb-item', backup.name);
    var details = when(backup.createdAt) + ' · ' + size(backup.bytes);
    if (status && backup.keyId && status.keyId && backup.keyId !== status.keyId) details += ' · sealed to other words';
    if (backup.accountEmail) details += ' · ' + backup.accountEmail;
    if (!backup.scheduled) details += ' · kept until you delete it';
    about.appendChild(element('small', '', details));
    row.appendChild(about);
    var actions = element('div', 'fb-item-actions');
    var save = button('Save plain copy…', 'save');
    save.addEventListener('click', function () { act('backup.save', { id: backup.id }, 'Choose where to save it, in the window that opened.', 'Saved. That copy isn\'t sealed: keep it safe.'); });
    var restore = button('Restore…', 'restore');
    restore.addEventListener('click', function () { act('backup.restore', { id: backup.id }, 'Answer the window that opened.', 'Restored to FormLogic as new copies.'); });
    var remove = button('Delete…', 'delete', 'is-danger');
    remove.addEventListener('click', function () { act('backup.delete', { id: backup.id }, 'Answer the window that opened.', 'Deleted.'); });
    actions.appendChild(save);
    actions.appendChild(restore);
    actions.appendChild(remove);
    row.appendChild(actions);
    return row;
  }

  function renderBackups(answer) {
    var list = $('fb-backups');
    list.textContent = '';
    answer.backups.forEach(function (backup) { list.appendChild(renderBackup(backup)); });
    show('fb-backups-empty', answer.total === 0);
    show('fb-backups-more', answer.total > answer.backups.length);
    show('fb-where-plugin', !answer.folder);
    show('fb-where-chosen', !!answer.folder);
    show('fb-use-own-folder', !!answer.folder);
    show('fb-folder-missing', !!(status && status.folderMissing));
    $('fb-folder').textContent = answer.folder || '';
    var last = answer.lastRun;
    show('fb-last-run', !!last);
    if (last) {
      var text = 'Last run ' + when(last.at) + ': ' + last.saved + ' saved.';
      if (last.stopped) text += ' It stopped: ' + last.stopped;
      (last.failed || []).forEach(function (failure) { text += ' ' + failure.name + ': ' + failure.reason; });
      var unsaid = (last.failedTotal || 0) - (last.failed || []).length;
      if (unsaid > 0) text += ' And ' + unsaid + ' more.';
      $('fb-last-run').textContent = text;
    }
  }

  /** As many backups as the page is showing, a page at a time: an answer to OAIY has a limit. */
  function loadBackups() {
    var gathered = [];
    function next() {
      return call('backups.list', { offset: gathered.length, limit: Math.min(MOST_AT_ONCE, shown - gathered.length) }).then(function (answer) {
        gathered = gathered.concat(answer.backups);
        var more = gathered.length < shown && gathered.length < answer.total && answer.backups.length > 0;
        return more ? next() : { backups: gathered, total: answer.total, lastRun: answer.lastRun, folder: answer.folder };
      });
    }
    return next();
  }

  function renderStatus(link) {
    show('fb-no-windows', !status.canAsk);
    show('fb-connect', !status.linked);
    show('fb-linked', status.linked);
    if (status.linked) {
      $('fb-linked-server').textContent = link.server || '';
      $('fb-linked-account').textContent = link.accountEmail || '';
      $('fb-fingerprint').textContent = status.fingerprint || '';
    }
    var relink = status.state === 'needs-link' && status.linked;
    show('fb-relink', relink);
    show('fb-not-offered', status.state === 'not-offered');
    show('fb-approve', status.linked && !status.approved && !relink && status.state !== 'not-offered');
    show('fb-key-none', !status.hasKey);
    show('fb-key-set', status.hasKey);
    $('fb-key-id').textContent = status.keyId ? 'Key ' + status.keyId : '';
    if (status.hasKey) $('fb-recover').querySelector('summary').textContent = 'Use different words';
    paint();
  }

  function refresh() {
    return call('status.get')
      .then(function (answer) {
        var wasApproved = status && status.approved;
        status = answer;
        return call('link.get').then(function (link) {
          renderStatus(link);
          if (status.approved && !wasApproved) loadSources();
          return loadBackups();
        });
      })
      .then(renderBackups)
      .catch(function (error) { say('bad', words(error)); });
  }

  function loadSettings() {
    return call('settings.get').then(function (settings) {
      $('fb-enabled').checked = settings.enabled;
      $('fb-every').value = settings.everyHours;
      $('fb-keep').value = settings.keep;
    }).catch(function () {});
  }

  $('fb-connect').addEventListener('submit', function (event) {
    event.preventDefault();
    act('link.connect', { server: $('fb-server').value }, 'Answer the window that opened.', function (result) {
      return 'Connected to ' + result.server + '. Now approve this computer in FormLogic.';
    });
  });

  $('fb-forget').addEventListener('click', function () {
    act('link.forget', {}, 'Answer the window that opened.', function (result) {
      return result.endedAtServer
        ? 'Link forgotten.'
        : 'Forgotten here, but FormLogic could not be reached. Revoke this computer there, under Settings, Linked Desktops, Data nodes.';
    });
  });

  $('fb-setup').addEventListener('click', function () {
    act('key.setup', {}, 'Your words are in the window that opened.', 'Your key is ready.');
  });

  $('fb-recover-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var typed = $('fb-words');
    var given = typed.value.trim().toLowerCase().split(/\s+/).join(' ');
    typed.value = '';
    act('key.recover', { words: given }, 'Answer the window that opened.', 'Your key is ready.');
  });

  $('fb-run-all').addEventListener('click', function () {
    act('backup.run', {}, 'Backing up everything…', ranWords);
  });

  $('fb-sources-refresh').addEventListener('click', loadSources);

  $('fb-choose-folder').addEventListener('click', function () {
    act('backups.move', { to: 'chosen' }, 'Choose a folder in the window that opened.', 'Your backups are in the new folder.');
  });

  $('fb-use-own-folder').addEventListener('click', function () {
    act('backups.move', { to: 'plugin' }, 'Answer the window that opened.', 'Your backups are back in the plugin\'s folder.');
  });

  $('fb-backups-more').addEventListener('click', function () {
    shown += PAGE;
    refresh();
  });

  $('fb-schedule').addEventListener('submit', function (event) {
    event.preventDefault();
    act('settings.set', {
      enabled: $('fb-enabled').checked,
      everyHours: Number($('fb-every').value),
      keep: Number($('fb-keep').value),
    }, 'Saving…', 'Saved.').then(loadSettings);
  });

  refresh();
  loadSettings();
  setInterval(function () { if (!busy && !document.hidden) refresh(); }, 5000);
})();
