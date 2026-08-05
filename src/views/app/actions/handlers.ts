import { openInBrowser } from '../../../lib/cli-utils';
import type { BacklogViewModel } from '../../board/data/backlog-adapter';
import type { StateContextValue } from '../state/StateContext';

export type UrlOpener = (url: string) => Promise<void>;

/** Open only a provider-supplied URL; IDs and provider references are not URLs. */
export async function openBacklogUrl(
  item: Pick<BacklogViewModel, 'id' | 'webUrl'>,
  opener: UrlOpener = openInBrowser,
): Promise<boolean> {
  if (!item.webUrl) return false;
  await opener(item.webUrl);
  return true;
}

export function createActions(ctx: StateContextValue) {
  const { state, dispatch } = ctx;
  const notify = (message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info') => {
    dispatch({ type: 'notification:show', payload: { message, type } });
    setTimeout(() => dispatch({ type: 'notification:dismiss' }), 2700);
    setTimeout(() => dispatch({ type: 'notification:hide' }), 3000);
  };

  return {
    goBack: () => dispatch({ type: 'dispatch', payload: { type: 'navigate:back' } }),
    switchView: (view: string) => dispatch({ type: 'navigate:switch', payload: { view } }),
    viewDetail: () => dispatch({ type: 'navigate:goto-detail' }),
    viewList: () => dispatch({ type: 'navigate:goto-list' }),
    enableSearch: () => {
      dispatch({ type: 'search:enable' });
      dispatch({ type: 'selection:top' });
    },
    disableSearch: () => dispatch({ type: 'search:disable' }),
    appendSearchChar: (char: string) => dispatch({ type: 'search:set-query', payload: { query: state.searchQuery + char } }),
    backspaceSearch: () => dispatch({ type: 'search:set-query', payload: { query: state.searchQuery.slice(0, -1) } }),
    toggleHelp: () => dispatch({ type: 'help:toggle' }),
    toggleDebug: () => dispatch({ type: 'debug:toggle' }),
    notify,
    selectionDown: (length: number) => dispatch({ type: 'selection:down', payload: { length } }),
    selectionUp: () => dispatch({ type: 'selection:up' }),
    selectionTop: () => dispatch({ type: 'selection:top' }),
    selectionBottom: (length: number) => dispatch({ type: 'selection:bottom', payload: { length } }),
    openInBrowser: async (url: string, label?: string) => {
      try {
        await openInBrowser(url);
        notify(`opened ${label ?? url}`, 'success');
        return true;
      } catch {
        notify('open failed', 'error');
        return false;
      }
    },
    openBacklog: async (item: Pick<BacklogViewModel, 'id' | 'webUrl'>) => {
      try {
        const opened = await openBacklogUrl(item);
        notify(opened ? `opened backlog ${item.id}` : 'no browser URL', opened ? 'success' : 'warning');
        return opened;
      } catch {
        notify('open failed', 'error');
        return false;
      }
    },
  };
}
