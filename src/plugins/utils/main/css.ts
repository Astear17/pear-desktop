type Unregister = () => void;

let isLoaded = false;

const cssToInject = new Map<
  string,
  ((unregister: Unregister) => void) | undefined
>();

export const injectCSS = async (
  webContents: Electron.WebContents,
  css: string,
): Promise<Unregister> => {
  if (isLoaded) {
    const key = await webContents.insertCSS(css);
    return async () => await webContents.removeInsertedCSS(key);
  }

  return new Promise((resolve) => {
    if (cssToInject.size === 0) {
      setupCssInjection(webContents);
    }
    cssToInject.set(css, resolve);
  });
};

const setupCssInjection = (webContents: Electron.WebContents) => {
  webContents.on('did-finish-load', () => {
    isLoaded = true;

    cssToInject.forEach(async (callback, css) => {
      const key = await webContents.insertCSS(css);
      const remove = async () => await webContents.removeInsertedCSS(key);

      callback?.(remove);
    });
  });
};
