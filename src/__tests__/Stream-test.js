import EventSource, { sources, resetSources } from './EventSource-mock';
import * as stubPlatform from './stubPlatform';
import { asyncify, asyncSleep } from './testUtils';
import * as messages from '../messages';
import Stream from '../Stream';

const noop = () => {};

describe('Stream', () => {
  const baseUrl = 'https://example.com';
  const envName = 'testenv';
  const user = { key: 'me' };
  const encodedUser = 'eyJrZXkiOiJtZSJ9';
  const hash = '012345789abcde';
  let logger;
  let defaultConfig;
  let platform;

  beforeEach(() => {
    logger = stubPlatform.logger();
    defaultConfig = { streamUrl: baseUrl, logger };
    resetSources();
    platform = stubPlatform.defaults();
  });

  function expectStream(url) {
    if (sources[url]) {
      return sources[url];
    } else {
      throw new Error(
        'Did not open stream with expected URL of ' + url + '; active streams are: ' + Object.keys(sources).join(', ')
      );
    }
  }

  function expectOneStream() {
    const keys = Object.keys(sources);
    if (keys.length !== 1) {
      throw new Error('Expected only one stream; active streams are: ' + keys.join(', '));
    }
    return sources[keys[0]];
  }

  function onNewEventSource(f) {
    const factory = platform.eventSourceFactory;
    platform.eventSourceFactory = (url, options) => {
      const es = factory(url, options);
      f(es, url, options);
      return es;
    };
  }

  it('should not throw on EventSource when it does not exist', () => {
    const platform1 = { ...platform };
    delete platform1['eventSourceFactory'];

    const stream = new Stream(platform1, defaultConfig, envName);

    const connect = () => {
      stream.connect(noop);
    };

    expect(connect).not.toThrow(TypeError);
  });

  it('should not throw when calling disconnect without first calling connect', () => {
    const stream = new Stream(platform, defaultConfig, envName);
    const disconnect = () => {
      stream.disconnect(noop);
    };

    expect(disconnect).not.toThrow(TypeError);
  });

  it('connects to EventSource with eval stream URL by default', () => {
    const stream = new Stream(platform, defaultConfig, envName);
    stream.connect(user, {});

    const es = expectStream(baseUrl + '/eval/' + envName + '/' + encodedUser);
    expect(es.options).toEqual({});
  });

  it('adds secure mode hash to URL if provided', () => {
    const stream = new Stream(platform, defaultConfig, envName, hash);
    stream.connect(user, {});

    expectStream(baseUrl + '/eval/' + envName + '/' + encodedUser + '?h=' + hash);
  });

  it('falls back to ping stream URL if useReport is true and REPORT is not supported', () => {
    const config = { ...defaultConfig, useReport: true };
    const stream = new Stream(platform, config, envName, hash);
    stream.connect(user, {});

    expectStream(baseUrl + '/ping/' + envName);
  });

  it('sends request body if useReport is true and REPORT is supported', () => {
    const platform1 = { ...platform, eventSourceAllowsReport: true };
    const config = { ...defaultConfig, useReport: true };
    const stream = new Stream(platform1, config, envName);
    stream.connect(user, {});

    const es = expectStream(baseUrl + '/eval/' + envName);
    expect(es.options.method).toEqual('REPORT');
    expect(JSON.parse(es.options.body)).toEqual(user);
  });

  it('sets event listeners', () => {
    const stream = new Stream(platform, defaultConfig, envName);
    const fn1 = jest.fn();
    const fn2 = jest.fn();

    stream.connect(user, {
      birthday: fn1,
      anniversary: fn2,
    });

    const es = expectOneStream();

    es.mockEmit('birthday');
    expect(fn1).toHaveBeenCalled();
    expect(fn2).not.toHaveBeenCalled();

    es.mockEmit('anniversary');
    expect(fn2).toHaveBeenCalled();
  });

  it('reconnects after encountering an error', async () => {
    const config = { ...defaultConfig, streamReconnectDelay: 1, useReport: false };
    const stream = new Stream(platform, config, envName);
    stream.connect(user);

    let es = expectOneStream();
    expect(es.readyState).toBe(EventSource.CONNECTING);
    es.mockOpen();
    expect(es.readyState).toBe(EventSource.OPEN);

    const nAttempts = 5;
    for (let i = 0; i < nAttempts; i++) {
      const newEventSourcePromise = asyncify(onNewEventSource);

      es.mockError('test error');
      const es1 = await newEventSourcePromise;

      expect(es.readyState).toBe(EventSource.CLOSED);
      expect(es1.readyState).toBe(EventSource.CONNECTING);

      es1.mockOpen();
      await asyncSleep(0); // make sure the stream logic has a chance to catch up with the new EventSource state

      expect(stream.isConnected()).toBe(true);

      es = es1;
    }
  });

  it('logs a warning for only the first failed connection attempt', async () => {
    const config = { ...defaultConfig, streamReconnectDelay: 1 };
    const stream = new Stream(platform, config, envName);
    stream.connect(user);

    let es = expectOneStream();
    es.mockOpen();

    const nAttempts = 5;
    for (let i = 0; i < nAttempts; i++) {
      const newEventSourcePromise = asyncify(onNewEventSource);

      es.mockError('test error');
      es = await newEventSourcePromise;
      es.mockOpen();
    }

    // make sure there is just a single logged message rather than five (one per attempt)
    expect(logger.output.warn).toEqual([messages.streamError('test error', 1)]);
  });

  it('logs a warning again after a successful connection', async () => {
    const config = { ...defaultConfig, streamReconnectDelay: 1 };
    const stream = new Stream(platform, config, envName);
    const fakePut = jest.fn();
    stream.connect(user, {
      put: fakePut,
    });

    let es = expectOneStream();
    es.mockOpen();

    const nAttempts = 5;
    for (let i = 0; i < nAttempts; i++) {
      const newEventSourcePromise = asyncify(onNewEventSource);

      es.mockError('test error #1');
      es = await newEventSourcePromise;
      es.mockOpen();
    }

    // simulate the re-establishment of a successful connection
    es.mockEmit('put', 'something');
    expect(fakePut).toHaveBeenCalled();

    for (let i = 0; i < nAttempts; i++) {
      const newEventSourcePromise = asyncify(onNewEventSource);

      es.mockError('test error #2');
      es = await newEventSourcePromise;
      es.mockOpen();
    }

    // make sure there is just a single logged message rather than five (one per attempt)
    expect(logger.output.warn).toEqual([
      messages.streamError('test error #1', 1),
      messages.streamError('test error #2', 1),
    ]);
  });
});
