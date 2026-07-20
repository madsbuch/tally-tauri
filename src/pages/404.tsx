import { Navigate } from "react-router-dom";

/** Unknown paths (e.g. a WebView restoring an odd URL) land on the Diary. */
export default function NotFound() {
  return <Navigate to="/" replace />;
}
