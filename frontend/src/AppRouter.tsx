import { Route, Routes } from "react-router-dom";
import { AppContent } from "./App";
import { AuthProvider } from "./context/AuthContext";
import { InvitePage } from "./pages/InvitePage";
import { PublicTrustPage } from "./pages/PublicTrustPage";

export default function AppRouter() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/privacy" element={<PublicTrustPage page="privacy" />} />
        <Route path="/terms" element={<PublicTrustPage page="terms" />} />
        <Route path="/security" element={<PublicTrustPage page="security" />} />
        <Route path="/support" element={<PublicTrustPage page="support" />} />
        <Route path="/status" element={<PublicTrustPage page="status" />} />
        <Route path="/invite/:token" element={<InvitePage />} />
        <Route path="/login" element={<AppContent />} />
        <Route path="/" element={<AppContent />} />
        <Route path="/:spaceSeg" element={<AppContent />} />
        <Route path="/:spaceSeg/:sessionSeg" element={<AppContent />} />
      </Routes>
    </AuthProvider>
  );
}
