// FormLogic SDK (in-repo MVP location — spec §27.2).
//
// Import surface for custom screens / AI-generated app UI:
//
//   import { useConnector, useSubmitResponse, ConnectorStatus } from '../../sdk';
//
// Hooks and components wrap the app runtime store with permission-aware,
// documented capabilities so screens never touch raw endpoints or the native
// bridge directly. The server remains authoritative on every write.
export {
  useCurrentApp,
  useCurrentUser,
  useRole,
  usePermissions,
  useForms,
  useForm,
  useResponses,
  useSubmitResponse,
  useConnector,
  useConnectors,
  useToast,
  useAppNavigation,
  useRuntimeEnvironment,
  useOfflineQueue,
} from './hooks';
export type {
  SdkUser,
  SdkPermissions,
  SdkConnector,
  SdkConnectors,
  SdkNavigation,
  SdkResponseRow,
  SdkOfflineQueue,
  UseResponsesResult,
} from './hooks';

export { ConnectorStatus, SyncStatus, PermissionGate, EmptyState, ResponseList } from './components';

export type { RuntimeEnvironment } from '../client-runtime/detectEnvironment';
export type {
  ConnectorSummary,
  ConnectorStatusInfo,
  BrowserConnector,
} from '../client-runtime/connectors/connectorTypes';
