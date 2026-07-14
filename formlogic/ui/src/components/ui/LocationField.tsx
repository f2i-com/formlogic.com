import { useState } from 'react';
import { cn } from '../../lib/utils';

interface LocationValue {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

interface LocationFieldProps {
  value: unknown;
  onChange: (value: unknown) => void;
  primaryColor: string;
}

export function LocationField({ value, onChange, primaryColor }: LocationFieldProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const location = value as LocationValue | null;

  const getLocation = () => {
    if (!navigator.geolocation) {
      setError('Geolocation is not supported by your browser');
      return;
    }
    // Browsers only expose geolocation on secure contexts (https or localhost) —
    // surface that instead of a misleading "permission denied".
    if (window.isSecureContext === false) {
      setError('Location needs a secure (HTTPS) connection — this page was loaded over HTTP.');
      return;
    }

    setLoading(true);
    setError(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        onChange({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy ? Math.round(position.coords.accuracy) : undefined,
        });
        setLoading(false);
      },
      (err) => {
        setLoading(false);
        switch (err.code) {
          case err.PERMISSION_DENIED:
            setError('Location permission denied. Allow location access in your browser (check the address-bar icon), then try again. If this form is embedded, the host page must also permit location.');
            break;
          case err.POSITION_UNAVAILABLE:
            setError('Location information is unavailable.');
            break;
          case err.TIMEOUT:
            setError('Location request timed out. Please try again.');
            break;
          default:
            setError('An unknown error occurred.');
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 60000,
      }
    );
  };

  const clearLocation = () => {
    onChange(null);
    setError(null);
  };

  return (
    <div className="space-y-4">
      {!location ? (
        <button
          type="button"
          onClick={getLocation}
          disabled={loading}
          className={cn(
            "w-full flex flex-col items-center justify-center h-44 border-2 border-dashed rounded-xl transition-all cursor-pointer",
            loading ? "opacity-60" : "hover:border-current/40 hover:bg-current/5",
            "border-current/30"
          )}
        >
          <div className="flex flex-col items-center justify-center py-5">
            <div
              className="w-14 h-14 rounded-full flex items-center justify-center mb-4"
              style={{ backgroundColor: `${primaryColor}15` }}
            >
              {loading ? (
                <div className="w-7 h-7 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: primaryColor, borderTopColor: 'transparent' }} />
              ) : (
                <svg className="w-7 h-7" style={{ color: primaryColor }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              )}
            </div>
            <p className="text-lg opacity-70">
              {loading ? 'Getting your location...' : (
                <span><span className="font-semibold" style={{ color: primaryColor }}>Click to capture</span> your current location</span>
              )}
            </p>
            <p className="text-sm opacity-50 mt-2">
              Uses your device's GPS
            </p>
          </div>
        </button>
      ) : (
        <div className="border-2 rounded-xl overflow-hidden" style={{ borderColor: primaryColor }}>
          <div className="p-5 bg-current/5">
            <div className="flex items-start gap-4">
              <div
                className="w-12 h-12 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ backgroundColor: `${primaryColor}15` }}
              >
                <svg className="w-6 h-6" style={{ color: primaryColor }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold opacity-90 mb-1">Location captured</p>
                <div className="space-y-1 text-sm opacity-70">
                  <p>Lat: {location.latitude.toFixed(6)}</p>
                  <p>Lng: {location.longitude.toFixed(6)}</p>
                  {location.accuracy && <p>Accuracy: ~{location.accuracy}m</p>}
                </div>
              </div>
              <button
                type="button"
                onClick={clearLocation}
                aria-label="Clear location"
                className="p-2 opacity-50 hover:text-red-500 hover:opacity-100 hover:bg-red-500/10 rounded-lg transition-colors cursor-pointer"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
          <div className="px-5 py-3 border-t border-current/10 flex gap-2">
            <button
              type="button"
              onClick={getLocation}
              className="text-sm font-medium hover:opacity-80 transition-opacity cursor-pointer"
              style={{ color: primaryColor }}
            >
              Refresh location
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
