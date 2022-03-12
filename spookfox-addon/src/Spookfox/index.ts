import { v4 as uuid } from 'uuid';
import { OpenTab, SFTab } from '../tabs';
import setupBroker from './broker';

interface Response {
  requestId: string;
  payload: any;
}

interface Request {
  id: string;
  name: string;
  payload: any;
}

/**
 * Mutable data we need to keep track of. Lesser the better.
 */
export interface State {
  // All the tabs open in browser at any time. Assumption is that this list is
  // created when Emacs first connects, and then kept up-to-date by browser
  // itself whenever anything related to a tab changes
  openTabs: { [id: string]: OpenTab };
  // All tabs which are saved in Emacs. We obtain this list when Emacs first
  // connects. After that, any time something related to saved tabs changes,
  // this list should be updated *after the face*. i.e make the change in Emacs,
  // and then ask Emacs how this list looks like; either by asking for the whole
  // list again, or designing the response such that Emacs returns the updated
  // `SFTab`
  savedTabs: { [id: string]: SFTab };
  // Firefox containers, when configured to "auto-close tabs" cause a
  // race-condition where they rapidly create+close+create tabs. In this case,
  // the close callback gets called very quickly. On tab create, Emacs save the
  // tab and respond with the saved tab. But before it can do this, Firefox has
  // already closed the tab and emitted onClosed event. onClosed checks if we
  // already saved the tab, and since saving the tab hasn't finished yet,
  // concludes that we haven't. So this rapidly closed tab don't get removed
  // from Emacs. To resolve this, we need a `savingTabs` which keeps track if
  // tabs which are under-process of being saved.
  savingTabs: number[];
}

/**
 * Events known to Spookfox.
 * For documentation and ease of refactoring.
 */
export enum SFEvents {
  // Emacs sends a CONNECTED request when it connects. Browser don't tell
  // us when it is able to connect to the native app. I suppose it is implicit
  // that if it don't disconnects, it connects. Sounds like ancient wisdom.
  EMACS_CONNECTED = 'EMACS_CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
  // A request Emacs sent to do something or to provide some information
  REQUEST = 'REQUEST',
  // Response Emacs sent for a request we made
  RESPONSE = 'RESPONSE',
  // Spookfox has had a state change, and new state is available
  NEW_STATE = 'NEW_STATE',
}

/**
 * A custom event which has an optional payload attached.
 */
export class SFEvent<P = any> extends Event {
  constructor(
    public name: string,
    public payload?: P,
    public debugMessage?: string
  ) {
    super(name);
  }
}

/**
 * `Spookfox` is the heart of this addon.
 * # Usage
 * 1. Keep a single Spookfox instance. Spookfox will create its own `browser.runtime.port.Port`
 * ```
 * const sf = new Spookfox();
 * ```
 * 2. Create a `browser.runtime.port.Port` if you want multiple Spookfox instances around.
 * e.g for multiple windows?
 * ```
 * const port = browser.runtime.connectNative('spookfox');
 * const sf = new Spookfox(port);
 * ```
 * # Events
 * It emits `SFEvents`. `SFEvents.REQUEST` and `SFEvents.RESPONSE` don't
 * need to be handled manually. `Spookfox.request` and `Spookfox.registerReqHandler`
 * should be sufficient for most cases.
 */
// It extends `EventTarget` so we can have the ability to emit and listen to
// custom events. We rely on custom events to build independent modules, while
// providing a unified interface.
export class Spookfox extends EventTarget {
  state: State = {
    openTabs: {},
    savedTabs: {},
    savingTabs: [],
  };
  reqHandlers = {};

  constructor(public port?: browser.runtime.Port) {
    super();
    if (!port) {
      this.connect();
    }

    setupBroker(this);
    this.setupRequestHandler();
    this.setupResponseHandler();
    this.initStateOnReconnect();
    this.setupDisconnectHandler();
  }

  private connect() {
    if (this.port) this.port.disconnect();

    this.port = browser.runtime.connectNative('spookfox');
    return this.port;
  }

  /**
   * Send a request with NAME and PAYLOAD to Emacs.
   * Returns a promise of response returned by Emacs.
   * # Example
   * ```
   * const savedTabs = sf.request('GET_SAVED_TABS');
   * ```
   */
  request(name: string, payload?: object) {
    const request = {
      id: uuid(),
      name,
      payload,
    };

    this.port.postMessage(request);

    return this.getResponse(request.id);
  }

  /**
   * A convenience function for dispatching new events to `Spookfox`.
   */
  dispatch(name: string, payload?: object, msg?: string) {
    this.dispatchEvent(new SFEvent(name, payload, msg));
  }
  /**
   * Run a function when Emacs makes a request.
   * # Example
   * ```
   * sf.registerReqHandler('OPEN_TAB', ({ url }) => {
   *   // somehow open a new tab with `url` provided by Emacs.
   * })
   * ```
   */
  registerReqHandler(
    name: string,
    handler: (payload: any, sf: Spookfox) => object
  ) {
    if (this.reqHandlers[name]) {
      throw new Error(
        `Handler already registered. There can only by one handler per request. [request=${name}]`
      );
    }

    this.reqHandlers[name] = handler;
  }

  /**
   * Change Spookfox state. Calling this will set the state to new given state,
   * and emit `SFEvents.NEW_STATE` event.
   * Spookfox.state should be treated as immutable and shouldn't be modified in-place.
   * Instead, use `Spookfox.newState(s: State)` to replace existing state as a whole.
   * # Example
   * ```
   * const newState = { ... };
   * sf.newState(newState, 'X kind of change.');
   * ```
   */
  newState(s: State, debugMsg?: string) {
    this.state = s;
    this.dispatch(SFEvents.NEW_STATE, s, debugMsg);
  }

  /**
   * Handle `SFEvents.REQUEST` events.
   * Calling this is critical for processing any requests received from Emacs.
   */
  private setupRequestHandler = async () => {
    this.addEventListener(SFEvents.REQUEST, async (e: SFEvent<Request>) => {
      const request = e.payload;
      const executioner = this.reqHandlers[request.name];

      if (!executioner) {
        console.warn(
          `No handler for request [request=${JSON.stringify(request)}]`
        );
        return;
      }
      const response = await executioner(request.payload, this);

      return this.port.postMessage({
        requestId: request.id,
        payload: response,
      });
    });
  };

  /**
   * Handle `SFEvents.RESPONSE` events.
   * Calling this is critical for getting responses for any requests sent to
   * Emacs.
   */
  private setupResponseHandler() {
    this.addEventListener(SFEvents.RESPONSE, (e: SFEvent<Response>) => {
      const res = e.payload;

      if (!res.requestId) {
        throw new Error(`Invalid response: [res=${res}]`);
      }

      // Dispatch a unique event per `requestId`. Shenanigans I opted for doing
      // to build a promise based interface on request/response dance needed
      // for communication with Emacs. Check `Spookfox.getResponse`
      this.dispatch(res.requestId, res.payload);
    });
  }

  private getResponse(requestId: string) {
    const maxWait = 2000;

    return new Promise((resolve, reject) => {
      const listener = (event: SFEvent) => {
        clearTimeout(killTimer);
        this.removeEventListener(requestId, listener);

        resolve(event.payload);
      };
      const killTimer = setTimeout(() => {
        this.removeEventListener(requestId, listener);
        reject(new Error('Spookfox response timeout.'));
      }, maxWait);

      this.addEventListener(requestId, listener);
    });
  }

  /**
   * Initialize `Spookfox.state` When Emacs first connects.
   */
  private initStateOnReconnect() {
    this.addEventListener(SFEvents.EMACS_CONNECTED, async () => {
      const savedTabs = (await this.request('GET_SAVED_TABS')) as SFTab[];
      const currentTabs = await browser.tabs.query({ windowId: 1 });

      // Problem: There might be tabs with same URLs
      // Solution: First open tab in browser is mapped to first tab saved in Emacs.
      // Catch: Every time this function runs, all current tabs which match urls
      // saved in Emacs are mapped; regardless of whether user meant it or not.
      const takenSavedTabIds = [];
      const openTabs = currentTabs.reduce((accum, tab) => {
        const savedTab = savedTabs.find(
          (st) => st.url === tab.url && takenSavedTabIds.indexOf(st.id) === -1
        );
        if (savedTab) {
          takenSavedTabIds.push(savedTab.id);
          accum[tab.id] = {
            savedTabId: savedTab.id,
            ...tab,
          };
        } else {
          accum[tab.id] = tab;
        }

        return accum;
      }, {});

      const savedTabsMap = savedTabs.reduce((accum, tab) => {
        accum[tab.id] = tab;
        return accum;
      }, {});

      const newState = {
        ...this.state,
        openTabs,
        savedTabs: savedTabsMap,
      };

      this.newState(newState, 'INITIAL_STATE');
    });
  }

  /**
   * Handle disconnection from spookfox.
   */
  private setupDisconnectHandler() {
    this.addEventListener(SFEvents.DISCONNECTED, (err) => {
      console.warn('Spookfox disconnected. [err=', err, ']');
    });
  }
}
