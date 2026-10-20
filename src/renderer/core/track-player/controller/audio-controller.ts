/**
 * 播放音乐
 */
import albumImg from "@/assets/imgs/album-cover.jpg";
import getUrlExt from "@/renderer/utils/get-url-ext";
import Hls, { Events as HlsEvents, HlsConfig } from "hls.js";
import { isSameMedia } from "@/common/media-util";
import { toMediahubUrl, isLocalFileUrl } from "@/common/mediahub";
import { PlayerState } from "@/common/constant";
import { invoke } from "@tauri-apps/api/core";
import ControllerBase from "@renderer/core/track-player/controller/controller-base";
import { ErrorReason } from "@renderer/core/track-player/enum";
import voidCallback from "@/common/void-callback";
import { IAudioController } from "@/types/audio-controller";


class AudioController extends ControllerBase implements IAudioController {
    private audio: HTMLAudioElement;
    private hls: Hls;

    private _playerState: PlayerState = PlayerState.None;
    get playerState() {
        return this._playerState;
    }
    set playerState(value: PlayerState) {
        if (this._playerState !== value) {
            this.onPlayerStateChanged?.(value);
            // SMTC 上报（阶段2：系统媒体控制由 Rust souvlaki 实现）
            if (value === PlayerState.Playing || value === PlayerState.Paused) {
                invoke("smtc_update", {
                    update: { playing: value === PlayerState.Playing },
                }).catch(voidCallback);
            }
        }
        this._playerState = value;

    }

    public musicItem: IMusic.IMusicItem | null = null;

    get hasSource() {
        return !!this.audio.src;
    }

    constructor() {
        super();
        this.audio = new Audio();
        this.audio.preload = "auto";
        this.audio.controls = false;

        ////// events
        this.audio.onplaying = () => {
            this.playerState = PlayerState.Playing;
            navigator.mediaSession.playbackState = "playing";
        };

        this.audio.onpause = () => {
            this.playerState = PlayerState.Paused;
            navigator.mediaSession.playbackState = "paused";
        };

        this.audio.onerror = (event) => {
            this.playerState = PlayerState.Paused;
            navigator.mediaSession.playbackState = "paused";
            this.onError?.(ErrorReason.EmptyResource, event as any);
        };

        this.audio.ontimeupdate = () => {
            this.onProgressUpdate?.({
                currentTime: this.audio.currentTime,
                duration: this.audio.duration, // 缓冲中是Infinity
            });
            this.reportSmtcPosition();
        };

        this.audio.onloadedmetadata = () => {
            // 时长确定后补充 SMTC 元数据
            if (isFinite(this.audio.duration)) {
                invoke("smtc_update", {
                    update: {
                        title: this.musicItem?.title,
                        artist: this.musicItem?.artist,
                        album: this.musicItem?.album,
                        duration: this.audio.duration,
                    },
                }).catch(voidCallback);
            }
        };

        // this.audio.onseeking = () => {
        //     this.playerState = PlayerState.Buffering;
        // }
        //
        // this.audio.onseeked = () => {
        //     this.playerState = PlayerState.Playing;
        // }

        this.audio.onended = () => {
            this.playerState = PlayerState.Paused;
            this.onEnded?.();
        };

        this.audio.onvolumechange = () => {
            this.onVolumeChange?.(this.audio.volume);
        };

        this.audio.onratechange = () => {
            this.onSpeedChange?.(this.audio.playbackRate);
        };


        // @ts-ignore  isDev
        window.ad = this.audio;
    }

    private initHls(config?: Partial<HlsConfig>) {
        if (!this.hls) {
            this.hls = new Hls(config);
            this.hls.attachMedia(this.audio);
            this.hls.on(HlsEvents.ERROR, (evt, error) => {
                this.onError(ErrorReason.EmptyResource, error);
            });
        }
    }

    private destroyHls() {
        if (this.hls) {
            this.hls.detachMedia();
            this.hls.off(HlsEvents.ERROR);
            this.hls.destroy();
            this.hls = null;
        }
    }

    /** SMTC 进度上报（节流 1s） */
    private lastSmtcPositionReport = 0;
    private reportSmtcPosition() {
        const now = Date.now();
        if (now - this.lastSmtcPositionReport < 1000) {
            return;
        }
        this.lastSmtcPositionReport = now;
        invoke("smtc_update", {
            update: { position: this.audio.currentTime },
        }).catch(voidCallback);
    }

    destroy(): void {
        this.destroyHls();
        this.reset();
    }

    pause(): void {
        if (this.hasSource) {
            this.audio.pause();
        }
    }

    play(): void {
        if (this.hasSource) {
            this.audio.play().catch(voidCallback);
        }
    }

    reset(): void {
        this.playerState = PlayerState.None;
        this.audio.src = "";
        this.audio.removeAttribute("src");
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = "none";
    }

    seekTo(seconds: number): void {
        if (this.hasSource && isFinite(seconds)) {
            const duration = this.audio.duration;
            this.audio.currentTime = Math.min(
                seconds,
                isNaN(duration) ? Infinity : duration,
            );
        }
    }

    setLoop(isLoop: boolean): void {
        this.audio.loop = isLoop;
    }

    setSinkId(deviceId: string): Promise<void> {
        return (this.audio as any).setSinkId(deviceId);
    }

    setSpeed(speed: number): void {
        this.audio.defaultPlaybackRate = speed;
        this.audio.playbackRate = speed;
    }

    prepareTrack(musicItem: IMusic.IMusicItem) {
        this.musicItem = { ...musicItem };

        // 1. update metadata
        navigator.mediaSession.metadata = new MediaMetadata({
            title: musicItem.title,
            artist: musicItem.artist,
            album: musicItem.album,
            artwork: [
                {
                    src: musicItem.artwork ?? albumImg,
                },
            ],
        });
        invoke("smtc_update", {
            update: {
                title: musicItem.title,
                artist: musicItem.artist,
                album: musicItem.album,
            },
        }).catch(voidCallback);

        // 2. reset track
        this.playerState = PlayerState.None;
        this.audio.src = "";
        this.audio.removeAttribute("src");
        navigator.mediaSession.playbackState = "none";
    }

    setTrackSource(trackSource: IMusic.IMusicSource, musicItem: IMusic.IMusicItem): void {
        this.musicItem = { ...musicItem };

        // 1. update metadata
        navigator.mediaSession.metadata = new MediaMetadata({
            title: musicItem.title,
            artist: musicItem.artist,
            album: musicItem.album,
            artwork: [
                {
                    src: musicItem.artwork ?? albumImg,
                },
            ],
        });


        // 2. convert url and headers → mediahub:// 统一管线（阶段2）
        let url = trackSource.url;
        const urlObj = new URL(trackSource.url);
        let headers: Record<string, any> | null = null;

        // 2.1 convert user agent
        if (trackSource.headers || trackSource.userAgent) {
            headers = { ...(trackSource.headers ?? {}) };
            if (trackSource.userAgent) {
                headers["user-agent"] = trackSource.userAgent;
            }
        }

        // 2.2 convert auth header
        if (urlObj.username && urlObj.password) {
            const authHeader = `Basic ${btoa(
                `${decodeURIComponent(urlObj.username)}:${decodeURIComponent(
                    urlObj.password,
                )}`,
            )}`;
            urlObj.username = "";
            urlObj.password = "";
            headers = {
                ...(headers || {}),
                Authorization: authHeader,
            };
            url = urlObj.toString();
        }

        // 2.3 本地文件与带 header 的远程源统一走 mediahub 流式代理
        //     （对应原 _setHeaders hack + request-forwarder + fetch→blob 三套路径）
        if (headers || isLocalFileUrl(url)) {
            url = toMediahubUrl(url, headers ?? undefined);
        }

        if (!url) {
            this.onError(ErrorReason.EmptyResource, new Error("url is empty"));
            return;
        }

        // 3. set real source
        if (getUrlExt(trackSource.url) === ".m3u8") {
            if (Hls.isSupported()) {
                this.initHls();
                this.hls.loadSource(url);
            } else {
                this.onError(ErrorReason.UnsupportedResource);
                return;
            }
        } else {
            this.audio.src = url;
        }
    }

    setVolume(volume: number): void {
        this.audio.volume = volume;
    }
}

export default AudioController;
