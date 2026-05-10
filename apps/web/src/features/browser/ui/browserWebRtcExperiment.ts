import type {
  BrowserProxyWebRtcIceCandidate,
  BrowserProxyWebRtcSignalSource,
} from "@shared/types/browser-proxy";

export const BROWSER_WEBRTC_LOCAL_STORAGE_KEY = "deus.browserWebrtc";
export const BROWSER_WEBRTC_SEARCH_PARAM = "browserWebrtc";

export function isBrowserWebRtcExperimentEnabled(): boolean {
  if (typeof window === "undefined") return false;
  if (import.meta.env.VITE_BROWSER_WEBRTC === "1") return true;
  const param = new URLSearchParams(window.location.search).get(BROWSER_WEBRTC_SEARCH_PARAM);
  if (param === "1" || param === "true") return true;
  return window.localStorage.getItem(BROWSER_WEBRTC_LOCAL_STORAGE_KEY) === "1";
}

export function createBrowserRtcPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
}

export function makeBrowserWebRtcPeerId(tabId: string): string {
  const random = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `browser-${tabId}-${random}`;
}

export function serializeIceCandidate(candidate: RTCIceCandidate): BrowserProxyWebRtcIceCandidate {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    usernameFragment: candidate.usernameFragment,
  };
}

export function makeIceCommandParams(
  tabId: string,
  peerId: string,
  from: BrowserProxyWebRtcSignalSource,
  candidate: RTCIceCandidate
): Record<string, unknown> {
  return {
    tabId,
    peerId,
    from,
    candidate: serializeIceCandidate(candidate),
  };
}
