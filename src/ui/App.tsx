import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Repository } from '../data/repository';
import type { SessionPlan } from '../engine/planner';
import { getPlatform, type Platform } from '../platform';
import { AppContext } from './AppContext';
import { bootstrap } from './bootstrap';
import Free from './screens/Free';
import Home from './screens/Home';
import Progress from './screens/Progress';
import Session from './screens/Session';
import Settings from './screens/Settings';

/** Current screen. */
type Route =
  | { screen: 'home' }
  | { screen: 'session'; plan: SessionPlan }
  | { screen: 'free' }
  | { screen: 'progress' }
  | { screen: 'settings' };

type Boot = { status: 'loading' } | { status: 'ready'; repo: Repository } | { status: 'failed'; message: string };

export interface AppProps {
  /** Tests pass a fake; the app uses the host it runs in. */
  platform?: Platform;
}

function Screens({ route, go }: { route: Route; go: (next: Route) => void }) {
  const home = useCallback(() => { go({ screen: 'home' }); }, [go]);
  switch (route.screen) {
    case 'home':
      return (
        <Home
          onStart={(plan) => { go({ screen: 'session', plan }); }}
          onFree={() => { go({ screen: 'free' }); }}
          onProgress={() => { go({ screen: 'progress' }); }}
          onSettings={() => { go({ screen: 'settings' }); }}
        />
      );
    case 'session':
      return <Session plan={route.plan} onExit={home} />;
    case 'free':
      return <Free onStart={(plan) => { go({ screen: 'session', plan }); }} onBack={home} />;
    case 'progress':
      return <Progress onBack={home} />;
    case 'settings':
      return <Settings onBack={home} />;
  }
}

export default function App({ platform: given }: AppProps) {
  const platform = useMemo(() => given ?? getPlatform(), [given]);
  const [boot, setBoot] = useState<Boot>({ status: 'loading' });
  const [route, setRoute] = useState<Route>({ screen: 'home' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    bootstrap(platform).then(
      (repo) => {
        if (live) setBoot({ status: 'ready', repo });
      },
      (e: unknown) => {
        if (live) setBoot({ status: 'failed', message: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [platform, attempt]);

  const retry = (): void => {
    setBoot({ status: 'loading' });
    setAttempt((n) => n + 1);
  };

  return (
    <main>
      <h1>Тренажёр отбора</h1>
      {boot.status === 'loading' && <p>Загрузка…</p>}
      {boot.status === 'failed' && (
        <>
          <p role="alert">Не удалось открыть базу данных: {boot.message}</p>
          <div className="actions">
            <button type="button" onClick={retry}>
              Повторить
            </button>
          </div>
        </>
      )}
      {boot.status === 'ready' && (
        <AppContext.Provider value={{ platform, repo: boot.repo }}>
          <Screens route={route} go={setRoute} />
        </AppContext.Provider>
      )}
    </main>
  );
}
