import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, RefreshCcw, X } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import type { FormField } from '../../types/form';

interface FileMetadata {
  id: string;
  originalFilename: string;
  storedFilename: string;
  size: number;
  mimeType: string;
  url: string;
}

interface CameraFieldProps {
  field: FormField;
  value: unknown;
  onChange: (value: unknown) => void;
  primaryColor: string;
  formId?: string;
  appSlug?: string;
}

/** Longest edge of an uploaded photo — plenty for records/exports, kind to bandwidth. */
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.85;

/** Downscale an image blob/file to MAX_DIMENSION and re-encode as JPEG.
 *  Falls back to the original bytes if decoding fails (e.g. exotic format). */
async function resizeImage(source: Blob): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(source);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return source;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    return blob ?? source;
  } catch {
    return source;
  }
}

/**
 * Camera capture field — a file_upload variant (properties.captureMode === 'camera').
 * Opens the device camera in-page (getUserMedia) with a native <input capture> fallback,
 * downscales the shot client-side, and uploads through the normal file pipeline, so the
 * answer shape (and therefore records, exports, backups and restore) matches file uploads.
 */
export function CameraField({ field, value, onChange, primaryColor, formId, appSlug }: CameraFieldProps) {
  const [uploading, setUploading] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Local previews for photos taken THIS session (object URLs, keyed by file id) —
  // the server file URL may require auth, so freshly captured shots preview locally.
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const previewsLatest = useRef(previews);
  useEffect(() => { previewsLatest.current = previews; }, [previews]);

  const photos = useMemo(() => (value as FileMetadata[]) || [], [value]);
  const maxPhotos = field.properties.allowMultiple ? (field.properties.maxFiles ?? 5) : 1;
  const atCapacity = photos.length >= maxPhotos;

  const tint = (pct: number) => `color-mix(in srgb, ${primaryColor} ${pct}%, transparent)`;

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      stopStream();
      Object.values(previewsLatest.current).forEach((url) => URL.revokeObjectURL(url));
    };
  }, [stopStream]);

  const uploadBlob = useCallback(async (blob: Blob) => {
    if (!formId) {
      // "Form ID is not available" is a developer's sentence; the visitor can only act
      // on being told to reload.
      toast.error("Couldn't upload", 'Please reload the page and try again.');
      return;
    }
    setUploading(true);
    const resized = await resizeImage(blob);
    const file = new File([resized], `photo-${Date.now()}.jpg`, { type: resized.type || 'image/jpeg' });
    const result = appSlug
      ? await api.uploadAppFile(appSlug, formId, file, field.id)
      : await api.uploadFile(formId, file, field.id);
    setUploading(false);
    if (result.error || !result.data) {
      toast.error('Upload Failed', typeof result.error === 'string' ? result.error : undefined);
      return;
    }
    const newId = result.data.id;
    setPreviews((p) => ({ ...p, [newId]: URL.createObjectURL(resized) }));
    onChange(field.properties.allowMultiple ? [...photos, result.data] : [result.data]);
  }, [formId, appSlug, field.id, field.properties.allowMultiple, photos, onChange]);

  const openCamera = useCallback(async () => {
    setCameraError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      // No in-page camera — the hidden input's capture attribute opens the native one.
      fileInputRef.current?.click();
      return;
    }
    if (window.isSecureContext === false) {
      setCameraError('The camera needs a secure (HTTPS) connection — this page was loaded over HTTP.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOpen(true);
      // The <video> mounts with the state flip; attach on the next frame.
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => {});
        }
      });
    } catch (err) {
      const denied = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      if (denied) {
        setCameraError('Camera permission denied. Allow camera access in your browser (check the address-bar icon), or use the photo picker below.');
      } else {
        // No camera / hardware busy — fall back to the native picker.
        fileInputRef.current?.click();
      }
    }
  }, []);

  const closeCamera = useCallback(() => {
    stopStream();
    setCameraOpen(false);
  }, [stopStream]);

  const capture = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
    closeCamera();
    if (blob) await uploadBlob(blob);
  }, [closeCamera, uploadBlob]);

  const removePhoto = (index: number) => {
    const doomed = photos[index];
    const preview = doomed ? previews[doomed.id] : undefined;
    if (doomed && preview) {
      URL.revokeObjectURL(preview);
      setPreviews((p) => {
        const next = { ...p };
        delete next[doomed.id];
        return next;
      });
    }
    onChange(photos.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-4">
      {cameraOpen ? (
        <div className="relative overflow-hidden rounded-xl border-2 bg-black" style={{ borderColor: primaryColor }}>
          {/* live camera preview — video-only stream, no captions apply */}
          <video ref={videoRef} playsInline muted className="w-full max-h-[60vh] object-contain" />
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-4 p-4 bg-gradient-to-t from-black/70 to-transparent">
            <button
              type="button"
              onClick={closeCamera}
              className="px-4 py-2 rounded-full text-sm font-medium text-white bg-white/20 hover:bg-white/30 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => { void capture(); }}
              aria-label="Take photo"
              className="w-14 h-14 rounded-full border-4 border-white bg-white/30 hover:bg-white/50 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            />
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => { void openCamera(); }}
          disabled={uploading || atCapacity}
          className="w-full flex flex-col items-center justify-center h-44 border-2 border-dashed border-current/30 rounded-xl transition-all cursor-pointer hover:border-current/40 hover:bg-current/5 disabled:opacity-60 disabled:cursor-default"
          aria-busy={uploading}
        >
          <div className="w-14 h-14 rounded-full flex items-center justify-center mb-3" style={{ backgroundColor: tint(15) }}>
            {uploading ? (
              <div className="w-7 h-7 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: primaryColor, borderTopColor: 'transparent' }} />
            ) : (
              <Camera className="w-7 h-7" style={{ color: primaryColor }} />
            )}
          </div>
          <p className="text-lg opacity-70" role={uploading ? 'status' : undefined} aria-live={uploading ? 'polite' : undefined}>
            {uploading ? 'Uploading…' : atCapacity ? 'Photo attached' : (
              <span><span className="font-semibold" style={{ color: primaryColor }}>Take a photo</span> with your camera</span>
            )}
          </p>
          {!uploading && !atCapacity && (
            <p className="text-sm opacity-50 mt-1.5">Photos are resized before upload{maxPhotos > 1 ? ` • up to ${maxPhotos}` : ''}</p>
          )}
        </button>
      )}

      {/* Native fallback / gallery picker. capture="environment" opens the camera
          app directly on phones; on desktop it's a plain image picker. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        aria-label={field.label || 'Take a photo'}
        disabled={uploading || atCapacity}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void uploadBlob(file);
          e.target.value = '';
        }}
      />
      {!cameraOpen && !atCapacity && (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="text-sm font-medium hover:opacity-80 transition-opacity cursor-pointer"
          style={{ color: primaryColor }}
        >
          …or choose an existing photo
        </button>
      )}
      {cameraError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{cameraError}</p>
      )}

      {photos.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {photos.map((photo, index) => {
            const preview = previews[photo.id];
            return (
              <div key={photo.id} className="relative group/photo">
                {preview ? (
                  <img src={preview} alt={photo.originalFilename} className="h-28 w-28 object-cover rounded-xl border border-current/15" />
                ) : (
                  <div className="h-28 w-28 rounded-xl border border-current/15 flex flex-col items-center justify-center gap-1 p-2" style={{ backgroundColor: tint(8) }}>
                    <Camera className="h-6 w-6 opacity-60" style={{ color: primaryColor }} />
                    <span className="text-[10px] opacity-60 text-center break-all line-clamp-2">{photo.originalFilename}</span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removePhoto(index)}
                  aria-label="Remove photo"
                  className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-gray-900/80 text-white flex items-center justify-center hover:bg-red-500 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
          {atCapacity && maxPhotos === 1 && (
            <button
              type="button"
              onClick={() => { removePhoto(0); void openCamera(); }}
              disabled={uploading}
              className="h-28 w-28 rounded-xl border-2 border-dashed border-current/30 flex flex-col items-center justify-center gap-1 hover:border-current/50 hover:bg-current/5 transition-all cursor-pointer"
              aria-label="Retake photo"
            >
              <RefreshCcw className="h-5 w-5 opacity-60" style={{ color: primaryColor }} />
              <span className="text-xs opacity-60">Retake</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
