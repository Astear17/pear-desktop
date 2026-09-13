import PausedTrayIconWhite from '@assets/tray-paused-white.png?asset&asarUnpack';
import PausedTrayIcon from '@assets/tray-paused.png?asset&asarUnpack';
import TrayIconWhite from '@assets/tray-white.png?asset&asarUnpack';
import TrayIcon from '@assets/tray.png?asset&asarUnpack';
import { ipcMain, Menu, nativeImage, screen, Tray } from 'electron';
import is from 'electron-is';

import { APPLICATION_NAME, t } from '@/i18n';
import { LikeType } from '@/types/datahost-get-state';

import * as config from './config';
import { restart } from './providers/app-controls';
import { getSongControls } from './providers/song-controls';
import {
  registerCallback,
  unregisterCallback,
  SongInfoEvent,
  type SongInfoCallback,
} from './providers/song-info';
import { showOnCurrentDesktop } from './window-utils';

import type { MenuTemplate } from './menu';

// Prevent tray being garbage collected
let tray: Electron.Tray | undefined;
let traySongInfoCallback: SongInfoCallback | null = null;
let currentLikeStatus: LikeType = LikeType.Indifferent;

// The hover popup is drawn in the band the tray tooltip pops up in, so the
// tooltip can be silenced (empty string = Windows shows nothing) while the
// popup is visible, and restored from the last known text afterwards.
let trayTooltipText = '';
let trayTooltipSuppressed = false;

const updateTrayTooltip = () => {
  tray?.setToolTip(trayTooltipSuppressed ? '' : trayTooltipText);
};

export const setTrayTooltipSuppressed = (suppressed: boolean) => {
  trayTooltipSuppressed = suppressed;
  updateTrayTooltip();
};

type MouseMoveEvent = (
  event: Electron.KeyboardEvent,
  position: Electron.Point,
) => void;

// Plugins load before the tray is created, so queue handlers
// registered early and apply them once setUpTray runs.
let pendingMouseMove: MouseMoveEvent | null = null;

// macOS and Windows only
export const setTrayOnMouseMove = (fn: MouseMoveEvent) => {
  if (!tray) {
    pendingMouseMove = fn;
    return;
  }

  tray.removeAllListeners('mouse-move');
  tray.on('mouse-move', fn);
};

export const getTrayBounds = () => tray?.getBounds();

export const setUpTray = (app: Electron.App, win: Electron.BrowserWindow) => {
  if (!config.get('options.tray')) {
    tray?.destroy();
    tray = undefined;
    if (traySongInfoCallback) {
      unregisterCallback(traySongInfoCallback);
      traySongInfoCallback = null;
    }
    ipcMain.removeAllListeners('peard:like-changed');
    return;
  }

  // Unregister previous callback before re-registering
  if (traySongInfoCallback) {
    unregisterCallback(traySongInfoCallback);
  }

  // Remove old like-changed listener before re-registering
  ipcMain.removeAllListeners('peard:like-changed');

  const { playPause, next, previous, like, dislike } = getSongControls(win);

  const pixelRatio = is.windows()
    ? screen.getPrimaryDisplay().scaleFactor || 1
    : 1;

  const defaultTrayIcon = nativeImage
    .createFromPath(
      is.macOS() || config.get('options.trayForceWhiteIcons')
        ? TrayIconWhite
        : TrayIcon,
    )
    .resize({
      width: 16 * pixelRatio,
      height: 16 * pixelRatio,
    });
  const pausedTrayIcon = nativeImage
    .createFromPath(
      is.macOS() || config.get('options.trayForceWhiteIcons')
        ? PausedTrayIconWhite
        : PausedTrayIcon,
    )
    .resize({
      width: 16 * pixelRatio,
      height: 16 * pixelRatio,
    });

  tray = new Tray(defaultTrayIcon);

  trayTooltipText = t('main.tray.tooltip.default', {
    applicationName: APPLICATION_NAME,
  });
  updateTrayTooltip();

  // MacOS only
  tray.setIgnoreDoubleClickEvents(true);

  // Windows turns a click that lands within the system double-click time of the
  // previous one into WM_LBUTTONDBLCLK, and Electron reports that as
  // 'double-click' *instead* of 'click' (setIgnoreDoubleClickEvents is a no-op
  // off macOS). Listening to 'click' alone therefore dropped every click that
  // came too soon after the last one - the "sometimes I have to click twice".
  const onTrayClick = () => {
    if (config.get('options.trayClickPlayPause')) {
      playPause();
    } else if (win.isVisible()) {
      win.hide();
      app.dock?.hide();
    } else {
      if (config.get('options.trayMoveToCurrentDesktop')) {
        showOnCurrentDesktop(win);
      } else {
        win.show();
      }
      app.dock?.show();
    }
  };

  tray.on('click', onTrayClick);
  tray.on('double-click', onTrayClick);

  const buildTrayMenu = (): Menu => {
    const template: MenuTemplate = [
      {
        label: t('main.tray.play-pause'),
        click() {
          playPause();
        },
      },
      {
        label: t('main.tray.next'),
        click() {
          next();
        },
      },
      {
        label: t('main.tray.previous'),
        click() {
          previous();
        },
      },
      {
        label:
          currentLikeStatus === LikeType.Like
            ? t('main.tray.unlike')
            : t('main.tray.like'),
        click() {
          like();
        },
      },
      {
        label:
          currentLikeStatus === LikeType.Dislike
            ? t('main.tray.undislike')
            : t('main.tray.dislike'),
        click() {
          dislike();
        },
      },
      {
        label: t('main.tray.show'),
        click() {
          if (config.get('options.trayMoveToCurrentDesktop')) {
            showOnCurrentDesktop(win);
          } else {
            win.show();
          }
          app.dock?.show();
        },
      },
      { type: 'separator' },
      {
        label: t('main.tray.restart'),
        click: restart,
      },
      { type: 'separator' },
      {
        label: t('main.tray.quit'),
        role: 'quit',
      },
    ];

    return Menu.buildFromTemplate(template);
  };

  tray.setContextMenu(buildTrayMenu());

  // Listen for like status changes from the renderer
  win.webContents.send('peard:setup-like-changed-listener');
  ipcMain.on('peard:like-changed', (_, status: LikeType) => {
    currentLikeStatus = status;
    if (tray) {
      tray.setContextMenu(buildTrayMenu());
    }
  });

  traySongInfoCallback = (songInfo, event) => {
    if (event === SongInfoEvent.TimeChanged) return;

    if (tray) {
      if (typeof songInfo.isPaused === 'undefined') {
        tray.setImage(defaultTrayIcon);
        return;
      }

      trayTooltipText = t('main.tray.tooltip.with-song-info', {
        artist: songInfo.artist,
        title: songInfo.title,
        applicationName: APPLICATION_NAME,
      });
      updateTrayTooltip();

      tray.setImage(songInfo.isPaused ? pausedTrayIcon : defaultTrayIcon);
    }
  };
  registerCallback(traySongInfoCallback);

  // Apply any handlers that plugins registered before the tray existed
  if (pendingMouseMove) {
    tray.on('mouse-move', pendingMouseMove);
    pendingMouseMove = null;
  }
};
