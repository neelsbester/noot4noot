function waitForSpotifySDK(timeout = 12_000) {
  return new Promise((resolve, reject) => {
    if (window.Spotify?.Player) {
      resolve();
      return;
    }

    const startedAt = Date.now();
    const previousReady = window.onSpotifyWebPlaybackSDKReady;
    const check = window.setInterval(() => {
      if (window.Spotify?.Player) {
        window.clearInterval(check);
        resolve();
      } else if (Date.now() - startedAt >= timeout) {
        window.clearInterval(check);
        reject(new Error('Spotify browser player could not load.'));
      }
    }, 100);

    window.onSpotifyWebPlaybackSDKReady = () => {
      if (typeof previousReady === 'function') previousReady();
      window.clearInterval(check);
      resolve();
    };
  });
}

export async function createBrowserSpotifyPlayer({ getToken, onError }) {
  await waitForSpotifySDK();

  let deviceId = '';
  const player = new window.Spotify.Player({
    name: 'Noot4Noot Host',
    getOAuthToken: async callback => callback(await getToken()),
    volume: 0.8,
  });

  const report = fallback => ({ message } = {}) => onError(message || fallback);
  player.addListener('initialization_error', report('Spotify browser player could not start.'));
  player.addListener('authentication_error', report('Reconnect Spotify to enable browser audio.'));
  player.addListener('account_error', report('Spotify Premium is required for browser audio.'));
  player.addListener('playback_error', report('Spotify could not play that track.'));
  player.addListener('autoplay_failed', () => onError('Tap Play song again to allow audio on this device.'));

  await new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Spotify browser player timed out.')), 15_000);
    player.addListener('ready', ({ device_id: readyDeviceId }) => {
      window.clearTimeout(timeout);
      deviceId = readyDeviceId;
      resolve();
    });
    player.connect().then(connected => {
      if (!connected) {
        window.clearTimeout(timeout);
        reject(new Error('Spotify browser player could not connect.'));
      }
    }).catch(reject);
  });

  return {
    deviceId,
    activate: () => player.activateElement(),
    disconnect: () => player.disconnect(),
  };
}
