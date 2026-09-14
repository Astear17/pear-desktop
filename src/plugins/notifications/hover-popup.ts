import HoverPopupAsset from '@assets/hover-popup.html?asset';
import { BrowserWindow, screen, app } from 'electron';

import * as config from '@/config';
import { getSongControls } from '@/providers/song-controls';
import {
  registerCallback,
  type SongInfo,
  SongInfoEvent,
} from '@/providers/song-info';
import {
  setTrayOnMouseMove,
  getTrayBounds,
  setTrayTooltipSuppressed,
} from '@/tray';
import { showOnCurrentDesktop } from '@/window-utils';

import { watchTrayFlyout, type FlyoutRect } from './tray-flyout';

const POPUP_WIDTH = 380;
const POPUP_HEIGHT = 85;
const SHADOW_PAD = 8;
const GAP = 4;
// The shell draws the flyout's square inside its window with an invisible
// margin of its own (room for the drop shadow), so the window edge sits this
// much above the square. No probe can see it - the window answers hit-tests
// across its whole rectangle and DWM reports that same rectangle as the frame
// - so it is the one number this side adds back.
const FLYOUT_CARD_INSET = 8;

// Exported so interactive.ts can suppress toast notifications
// while the hover popup is visible
let _isVisible = false;
export const isHoverPopupVisible = () => _isVisible;

export const setupHoverPopup = (win: BrowserWindow): (() => void) => {
  const songControls = getSongControls(win);
  let currentSongInfo: SongInfo | null = null;
  let popup: BrowserWindow | null = null;
  let popupReady = false;
  let mouseTracker: ReturnType<typeof setInterval> | null = null;
  let cursorWasOnPopup = false;
  let topmostBumpTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  // Measured rectangle of the tray overflow flyout, in physical pixels, as
  // long as the flyout window has been seen at least once.
  let flyoutRect: FlyoutRect | null = null;
  const stopFlyoutWatch = watchTrayFlyout((rect) => {
    flyoutRect = rect;
  });

  const showMainWindow = () => {
    if (win.isDestroyed()) return;

    if (win.isMinimized()) win.restore();

    if (config.get('options.trayMoveToCurrentDesktop')) {
      showOnCurrentDesktop(win);
    } else {
      if (!win.isVisible()) win.show();
      win.focus();
    }

    app.dock?.show();
  };

  const createPopup = () => {
    popup = new BrowserWindow({
      width: POPUP_WIDTH + SHADOW_PAD * 2,
      height: POPUP_HEIGHT + SHADOW_PAD * 2,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    popup.loadFile(HoverPopupAsset);

    popup.webContents.on('did-finish-load', () => {
      popupReady = true;
    });

    // Button clicks from the popup HTML via document.title changes
    popup.on('page-title-updated', (event, title) => {
      if (!title.startsWith('act:')) return;
      event.preventDefault();
      const cmd = title.split(':')[1];

      switch (cmd) {
        case 'playPause':
          songControls.playPause();
          break;
        case 'previous':
          songControls.previous();
          break;
        case 'next':
          songControls.next();
          break;
        case 'show':
          showMainWindow();
          break;
      }
    });

    popup.on('closed', () => {
      popup = null;
      popupReady = false;
      _isVisible = false;
      setTrayTooltipSuppressed(false);
      stopMouseTracking();
    });
  };

  const positionPopup = () => {
    if (!popup) return;

    const bounds = getTrayBounds();
    if (!bounds) return;

    const display = screen.getDisplayNearestPoint({
      x: bounds.x,
      y: bounds.y,
    });
    const workArea = display.workArea;
    const winW = POPUP_WIDTH + SHADOW_PAD * 2;
    const winH = POPUP_HEIGHT + SHADOW_PAD * 2;
    const taskbarTop = workArea.y + workArea.height;

    // Center horizontally on tray icon
    let x = Math.round(bounds.x + bounds.width / 2 - winW / 2);
    // Position above tray icon
    let y = bounds.y - winH - GAP;

    // A tray icon hidden behind the "^" chevron lives in the overflow flyout,
    // which the shell draws in the band above the taskbar. Sitting on top of
    // the icon puts the popup inside that band, and the flyout is topmost like
    // the rest of the shell, so no amount of raising wins that fight: clear the
    // flyout's square instead, with the same gap the icon gets above the
    // taskbar.
    if (bounds.y + bounds.height <= taskbarTop && flyoutRect) {
      // The probe reports the flyout window; the square starts FLYOUT_CARD_INSET
      // below its top edge, so anchoring on the window alone leaves exactly that
      // margin as extra gap.
      const squareTop =
        screen.screenToDipPoint({ x: flyoutRect.left, y: flyoutRect.top }).y +
        FLYOUT_CARD_INSET * display.scaleFactor;
      y = squareTop - winH - GAP;
    }

    // Keep within screen bounds
    x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - winW));

    // If tray is at top of screen, position below instead
    if (bounds.y < workArea.y + workArea.height / 2) {
      y = bounds.y + bounds.height + GAP;
    }

    y = Math.max(workArea.y, y);
    popup.setPosition(x, y);
  };

  const isCursorOver = (bounds: Electron.Rectangle): boolean => {
    const cursor = screen.getCursorScreenPoint();
    return (
      cursor.x >= bounds.x &&
      cursor.x <= bounds.x + bounds.width &&
      cursor.y >= bounds.y &&
      cursor.y <= bounds.y + bounds.height
    );
  };

  // Poll cursor position every 150ms while popup is visible.
  // If mouse is on neither the popup nor the tray icon, hide.
  const startMouseTracking = () => {
    if (mouseTracker) return;
    mouseTracker = setInterval(() => {
      if (!popup || !_isVisible) {
        stopMouseTracking();
        return;
      }

      const overPopup = isCursorOver(popup.getBounds());
      const trayBounds = getTrayBounds();
      const overTray = trayBounds ? isCursorOver(trayBounds) : false;

      // Raise once when the cursor moves onto the popup, so hovering it brings
      // it back in front of whatever was raised over it while it stayed open.
      if (overPopup && !cursorWasOnPopup) raisePopup();
      cursorWasOnPopup = overPopup;

      if (!overPopup && !overTray) {
        doHide();
        stopMouseTracking();
      }
    }, 150);
  };

  const stopMouseTracking = () => {
    if (mouseTracker) {
      clearInterval(mouseTracker);
      mouseTracker = null;
    }
  };

  // The tray flyout sits in the always-on-top band with the rest of the shell,
  // which moveTop() cannot outrank. Stepping into that band for a moment wins
  // the fight; dropping the flag again leaves the popup where it landed — over
  // what it beat, under anything raised after it.
  const raisePopup = () => {
    if (!popup) return;
    popup.setAlwaysOnTop(true);
    if (topmostBumpTimer) clearTimeout(topmostBumpTimer);
    topmostBumpTimer = setTimeout(() => {
      topmostBumpTimer = null;
      popup?.setAlwaysOnTop(false);
    }, 200);
  };

  const doShow = () => {
    if (disposed) return;
    if (!popup) createPopup();
    if (!popup || !currentSongInfo) return;

    if (!_isVisible) {
      positionPopup();
      popup.showInactive();
      _isVisible = true;
      setTrayTooltipSuppressed(true);
      startMouseTracking();
    }

    // Hovering the tray icon raises an already-visible popup (showInactive()
    // does not raise it again by itself).
    raisePopup();

    if (popupReady) {
      pushSongInfo();
      popup.webContents.executeJavaScript('window.showPopup()').catch(() => {});
    }
  };

  const doHide = () => {
    if (!popup || !_isVisible) return;

    if (popupReady) {
      popup.webContents.executeJavaScript('window.hidePopup()').catch(() => {});
    }

    // Wait for CSS fade-out animation before hiding the window
    setTimeout(() => {
      if (popup && _isVisible) {
        // Final check: is the cursor back on popup or tray?
        const overPopup = isCursorOver(popup.getBounds());
        const trayBounds = getTrayBounds();
        const overTray = trayBounds ? isCursorOver(trayBounds) : false;
        if (overPopup || overTray) {
          // Cursor came back, re-show and resume tracking
          popup.webContents
            .executeJavaScript('window.showPopup()')
            .catch(() => {});
          startMouseTracking();
          return;
        }

        popup.hide();
        _isVisible = false;
        setTrayTooltipSuppressed(false);
      }
    }, 250);
  };

  const pushSongInfo = () => {
    if (!popup || !popupReady || !currentSongInfo) return;

    const data = JSON.stringify({
      title: currentSongInfo.title,
      artist: currentSongInfo.artist,
      imageSrc: currentSongInfo.imageSrc || '',
      isPaused: currentSongInfo.isPaused ?? false,
    });

    popup.webContents
      .executeJavaScript(`window.updateSongInfo(${data})`)
      .catch(() => {});
  };

  // Tray hover triggers popup
  setTrayOnMouseMove(() => {
    doShow();
  });

  // Track current song info
  registerCallback((songInfo, event) => {
    if (event === SongInfoEvent.TimeChanged) return;
    if (!songInfo.artist && !songInfo.title) return;

    currentSongInfo = { ...songInfo };
    if (_isVisible) pushSongInfo();
  });

  // Cleanup on quit or config disable. Detaches its own quit listener so a
  // disable/re-enable cycle does not leave one behind per toggle.
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    app.removeListener('before-quit', dispose);
    stopMouseTracking();
    stopFlyoutWatch();
    popup?.close();
  };

  app.on('before-quit', dispose);

  return dispose;
};
