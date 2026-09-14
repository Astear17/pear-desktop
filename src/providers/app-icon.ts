import musicPlayerIconYtm from '@assets/icon-ytm.png?asset&asarUnpack';
import musicPlayerIcon from '@assets/icon.png?asset&asarUnpack';
import pausedTrayIconWhite from '@assets/tray-paused-white.png?asset&asarUnpack';
import pausedTrayIconYtm from '@assets/tray-paused-ytm.png?asset&asarUnpack';
import pausedTrayIcon from '@assets/tray-paused.png?asset&asarUnpack';
import trayIconWhite from '@assets/tray-white.png?asset&asarUnpack';
import trayIconYtm from '@assets/tray-ytm.png?asset&asarUnpack';
import trayIcon from '@assets/tray.png?asset&asarUnpack';
import is from 'electron-is';

import * as config from '@/config';

export const useYtmIcons = () => config.get('options.useYtmIcons');

// Logo used for the About panel, notifications, TouchBar and dialogs.
export const appIconPath = () =>
  useYtmIcons() ? musicPlayerIconYtm : musicPlayerIcon;

// Window/taskbar icon. The packaged .ico/.icns is crisper at small sizes, but
// the original logo only ships as a PNG.
export const windowIconPath = () => {
  if (useYtmIcons()) return musicPlayerIconYtm;
  if (is.windows()) return 'assets/generated/icons/win/icon.ico';
  if (is.macOS()) return 'assets/generated/icons/mac/icon.icns';
  return musicPlayerIcon;
};

// Dialog/prompt icon, which historically uses the tray artwork.
export const dialogIconPath = () => (useYtmIcons() ? trayIconYtm : trayIcon);

export const trayIconPaths = () => {
  if (useYtmIcons()) {
    return { default: trayIconYtm, paused: pausedTrayIconYtm };
  }

  if (is.macOS() || config.get('options.trayForceWhiteIcons')) {
    return { default: trayIconWhite, paused: pausedTrayIconWhite };
  }

  return { default: trayIcon, paused: pausedTrayIcon };
};
