import { useState } from 'react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { cn } from '../../lib/utils';
import type { FormField } from '../../types/form';

interface FileMetadata {
  id: string;
  originalFilename: string;
  storedFilename: string;
  size: number;
  mimeType: string;
  url: string;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

interface FileUploadFieldProps {
  field: FormField;
  value: unknown;
  onChange: (value: unknown) => void;
  primaryColor: string;
  formId?: string;
  appSlug?: string;
}

export function FileUploadField({ field, value, onChange, primaryColor, formId, appSlug }: FileUploadFieldProps) {
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const uploadedFiles = (value as FileMetadata[]) || [];

  // color-mix works whether primaryColor is a hex or a CSS var(); plain hex-alpha
  // concatenation (`${primaryColor}15`) produces invalid colors for var()/named colors.
  const tint = (pct: number) => `color-mix(in srgb, ${primaryColor} ${pct}%, transparent)`;

  const handleFiles = async (files: File[]) => {
    if (!formId) {
      toast.error('Upload Error', 'Form ID is not available');
      return;
    }

    const maxSize = field.properties.maxFileSize;

    // Validate file sizes client-side
    if (maxSize) {
      const oversizedFiles = files.filter(f => f.size > maxSize);
      if (oversizedFiles.length > 0) {
        toast.error(
          'File Too Large',
          `${oversizedFiles[0].name} exceeds the maximum size of ${formatFileSize(maxSize)}`
        );
        files = files.filter(f => f.size <= maxSize);
        if (files.length === 0) return;
      }
    }

    setUploading(true);

    const newFiles: FileMetadata[] = [];
    for (const file of files) {
      const result = appSlug
        ? await api.uploadAppFile(appSlug, formId, file)
        : await api.uploadFile(formId, file);

      if (result.error) {
        toast.error('Upload Failed', result.error);
      } else if (result.data) {
        newFiles.push(result.data);
      }
    }

    setUploading(false);

    if (newFiles.length > 0) {
      onChange(field.properties.allowMultiple ? [...uploadedFiles, ...newFiles] : newFiles);
    }
  };

  const removeFile = (index: number) => {
    onChange(uploadedFiles.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-4">
      <label
        aria-busy={uploading}
        onDragOver={(e) => { if (!uploading) { e.preventDefault(); setDragOver(true); } }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (uploading) return;
          const files = Array.from(e.dataTransfer.files || []);
          if (files.length > 0) handleFiles(field.properties.allowMultiple ? files : files.slice(0, 1));
        }}
        className={cn(
          "flex flex-col items-center justify-center w-full h-44 border-2 border-dashed rounded-xl cursor-pointer transition-all",
          "focus-within:ring-2 focus-within:ring-primary-500 focus-within:border-primary-500",
          uploading ? "opacity-60 pointer-events-none" : "",
          uploadedFiles.length > 0 || dragOver
            ? "border-current/30 bg-current/5"
            : "border-current/30 hover:border-current/40 hover:bg-current/5"
        )}
        style={(uploadedFiles.length > 0 || dragOver) ? { borderColor: primaryColor, backgroundColor: tint(dragOver ? 14 : 8) } : {}}
      >
        <div className="flex flex-col items-center justify-center py-5">
          {uploading ? (
            <>
              <div className="w-14 h-14 rounded-full flex items-center justify-center mb-4" style={{ backgroundColor: tint(15) }}>
                <div className="w-7 h-7 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: primaryColor, borderTopColor: 'transparent' }} />
              </div>
              <p className="text-lg opacity-70" role="status" aria-live="polite">Uploading...</p>
            </>
          ) : (
            <>
              <div
                className="w-14 h-14 rounded-full flex items-center justify-center mb-4"
                style={{ backgroundColor: tint(15) }}
              >
                <svg className="w-7 h-7" style={{ color: primaryColor }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
              </div>
              <p className="text-lg opacity-70">
                <span className="font-semibold" style={{ color: primaryColor }}>Click to upload</span> or drag and drop
              </p>
              <p className="text-sm opacity-50 mt-2">
                {field.properties.acceptedFileTypes?.length
                  ? field.properties.acceptedFileTypes.join(', ')
                  : 'Any file type'}
                {field.properties.maxFileSize && ` • Max ${formatFileSize(field.properties.maxFileSize)}`}
              </p>
            </>
          )}
        </div>
        <input
          type="file"
          className="sr-only"
          aria-label={field.label || 'Upload file'}
          multiple={field.properties.allowMultiple}
          accept={field.properties.acceptedFileTypes?.join(',')}
          disabled={uploading}
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            if (files.length > 0) handleFiles(files);
            e.target.value = '';
          }}
        />
      </label>
      {uploadedFiles.length > 0 && (
        <div className="space-y-2">
          {uploadedFiles.map((file, index) => (
            <div key={file.id} className="flex items-center gap-3 p-4 bg-current/5 rounded-xl border border-current/15">
              <div
                className="w-12 h-12 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ backgroundColor: tint(15) }}
              >
                {file.mimeType?.startsWith('image/') ? (
                  <svg className="w-6 h-6" style={{ color: primaryColor }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                ) : (
                  <svg className="w-6 h-6" style={{ color: primaryColor }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium opacity-80 truncate">{file.originalFilename}</p>
                <p className="text-sm opacity-50">{formatFileSize(file.size)}</p>
              </div>
              <button
                type="button"
                onClick={() => removeFile(index)}
                aria-label="Remove file"
                className="p-2 opacity-50 hover:text-red-500 hover:opacity-100 hover:bg-red-500/10 rounded-lg transition-colors cursor-pointer"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
