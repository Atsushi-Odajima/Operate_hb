import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { Layout } from './Layout';
import { Spinner, ToastProvider } from './ui';
import { Login } from './pages/Login';

const Home = lazy(() => import('./pages/Home'));
const Search = lazy(() => import('./pages/Search'));
const Documents = lazy(() => import('./pages/Documents'));
const NewDocument = lazy(() => import('./pages/NewDocument'));
const DocumentView = lazy(() => import('./pages/DocumentView'));
const DocumentEdit = lazy(() => import('./pages/DocumentEdit'));
const Review = lazy(() => import('./pages/Review'));
const History = lazy(() => import('./pages/History'));
const StepRun = lazy(() => import('./pages/StepRun'));
const Checklists = lazy(() => import('./pages/Checklists'));
const Inbox = lazy(() => import('./pages/Inbox'));
const MyTraining = lazy(() => import('./pages/MyTraining'));
const AssignmentPage = lazy(() => import('./pages/Assignment'));
const TrainingAdmin = lazy(() => import('./pages/TrainingAdmin'));
const CourseEdit = lazy(() => import('./pages/CourseEdit'));
const QuizEdit = lazy(() => import('./pages/QuizEdit'));
const Attestations = lazy(() => import('./pages/Attestations'));
const Feedback = lazy(() => import('./pages/Feedback'));
const Health = lazy(() => import('./pages/Health'));
const Audit = lazy(() => import('./pages/Audit'));
const Admin = lazy(() => import('./pages/Admin'));
const Import = lazy(() => import('./pages/Import'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Offline = lazy(() => import('./pages/Offline'));
const Account = lazy(() => import('./pages/Account'));

function Guard({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner />;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <Layout><Suspense fallback={<Spinner />}>{children}</Suspense></Layout>;
}

export function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<Guard><Home /></Guard>} />
            <Route path="/search" element={<Guard><Search /></Guard>} />
            <Route path="/documents" element={<Guard><Documents /></Guard>} />
            <Route path="/documents/new" element={<Guard><NewDocument /></Guard>} />
            <Route path="/documents/:id" element={<Guard><DocumentView /></Guard>} />
            <Route path="/documents/:id/edit" element={<Guard><DocumentEdit /></Guard>} />
            <Route path="/documents/:id/review/:versionId" element={<Guard><Review /></Guard>} />
            <Route path="/documents/:id/history" element={<Guard><History /></Guard>} />
            <Route path="/documents/:id/run" element={<Guard><StepRun /></Guard>} />
            <Route path="/checklists" element={<Guard><Checklists /></Guard>} />
            <Route path="/checklists/:runId" element={<Guard><StepRun /></Guard>} />
            <Route path="/inbox" element={<Guard><Inbox /></Guard>} />
            <Route path="/training" element={<Guard><MyTraining /></Guard>} />
            <Route path="/training/:id" element={<Guard><AssignmentPage /></Guard>} />
            <Route path="/manage/training" element={<Guard><TrainingAdmin /></Guard>} />
            <Route path="/manage/courses/:id" element={<Guard><CourseEdit /></Guard>} />
            <Route path="/manage/quizzes/:id" element={<Guard><QuizEdit /></Guard>} />
            <Route path="/attestations" element={<Guard><Attestations /></Guard>} />
            <Route path="/feedback" element={<Guard><Feedback /></Guard>} />
            <Route path="/improvements" element={<Guard><Feedback /></Guard>} />
            <Route path="/health" element={<Guard><Health /></Guard>} />
            <Route path="/audit" element={<Guard><Audit /></Guard>} />
            <Route path="/admin" element={<Guard><Admin /></Guard>} />
            <Route path="/import" element={<Guard><Import /></Guard>} />
            <Route path="/notifications" element={<Guard><Notifications /></Guard>} />
            <Route path="/offline" element={<Guard><Offline /></Guard>} />
            <Route path="/account" element={<Guard><Account /></Guard>} />
            <Route path="*" element={<Guard><div className="empty">ページが見つかりません。<a href="/">ホームへ</a></div></Guard>} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ToastProvider>
  );
}
