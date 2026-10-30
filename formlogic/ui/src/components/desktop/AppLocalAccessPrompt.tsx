import { useEffect, useState } from 'react';
import { subscribeAppAccessRequests, type AppAccessRequest } from '../../client-runtime/appLocalAccess';
import { ConfirmDialog } from '../ui/ConfirmDialog';

/** Asks whether an app someone else manages may use this person's AI and OAIY (client-runtime/appLocalAccess.ts). */
export function AppLocalAccessPrompt() {
  const [request, setRequest] = useState<AppAccessRequest | null>(null);
  useEffect(() => subscribeAppAccessRequests(setRequest), []);
  if (!request) return null;
  return (
    <ConfirmDialog
      isOpen
      title={`Let ${request.app.name} use this computer?`}
      message="This app wants to use your AI and OAIY on this computer. If you allow it, whoever runs this app can use your plugins, such as your phone, and spend your AI. Only allow apps you trust. You can take this back in Settings."
      confirmLabel="Allow"
      cancelLabel="Not now"
      onConfirm={() => request.decide(true)}
      onClose={() => request.decide(false)}
    />
  );
}
