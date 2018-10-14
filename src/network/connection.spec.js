const { connectionOpts, sslConnectionOpts } = require('../../testHelpers')
const { requests } = require('../protocol/requests')
const Connection = require('./connection')
const Decoder = require('../protocol/decoder')

describe('Network > Connection', () => {
  // According to RFC 5737:
  // The blocks 192.0.2.0/24 (TEST-NET-1), 198.51.100.0/24 (TEST-NET-2),
  // and 203.0.113.0/24 (TEST-NET-3) are provided for use in documentation.
  const invalidIP = '203.0.113.1'
  const invalidHost = 'kafkajs.test'
  let connection

  afterEach(async () => {
    connection && (await connection.disconnect())
  })

  describe('#connect', () => {
    describe('PLAINTEXT', () => {
      beforeEach(() => {
        connection = new Connection(connectionOpts())
      })

      test('resolves the Promise when connected', async () => {
        await expect(connection.connect()).resolves.toEqual(true)
        expect(connection.connected).toEqual(true)
      })

      test('rejects the Promise in case of errors', async () => {
        connection.host = invalidHost
        await expect(connection.connect()).rejects.toHaveProperty(
          'message',
          'Connection error: getaddrinfo ENOTFOUND kafkajs.test kafkajs.test:9092'
        )
        expect(connection.connected).toEqual(false)
      })
    })

    describe('SSL', () => {
      beforeEach(() => {
        connection = new Connection(sslConnectionOpts())
      })

      test('resolves the Promise when connected', async () => {
        await expect(connection.connect()).resolves.toEqual(true)
        expect(connection.connected).toEqual(true)
      })

      test('rejects the Promise in case of timeouts', async () => {
        connection = new Connection(sslConnectionOpts({ connectionTimeout: 1 }))
        connection.host = invalidIP

        await expect(connection.connect()).rejects.toHaveProperty('message', 'Connection timeout')
        expect(connection.connected).toEqual(false)
      })

      test('rejects the Promise in case of errors', async () => {
        connection.ssl.cert = 'invalid'
        const message = 'Failed to connect: error:0906D06C:PEM routines:PEM_read_bio:no start line'
        await expect(connection.connect()).rejects.toHaveProperty('message', message)
        expect(connection.connected).toEqual(false)
      })
    })
  })

  describe('#disconnect', () => {
    beforeEach(() => {
      connection = new Connection(connectionOpts())
    })

    test('disconnects an active connection', async () => {
      await connection.connect()
      expect(connection.connected).toEqual(true)
      await expect(connection.disconnect()).resolves.toEqual(true)
      expect(connection.connected).toEqual(false)
    })
  })

  describe('#send', () => {
    let apiVersions

    beforeEach(() => {
      connection = new Connection(connectionOpts())
      apiVersions = requests.ApiVersions.protocol({ version: 0 })
    })

    test('resolves the Promise with the response', async () => {
      await connection.connect()
      await expect(connection.send(apiVersions())).resolves.toBeTruthy()
    })

    test('rejects the Promise if it is not connected', async () => {
      expect(connection.connected).toEqual(false)
      await expect(connection.send(apiVersions())).rejects.toEqual(new Error('Not connected'))
    })

    test('rejects the Promise in case of a non-retriable error', async () => {
      const debugStub = jest.fn()
      connection.logger.debug = debugStub
      const protocol = apiVersions()
      protocol.response.parse = () => {
        throw new Error('non-retriable')
      }
      await connection.connect()
      await expect(connection.send(protocol)).rejects.toEqual(new Error('non-retriable'))

      const lastCall = debugStub.mock.calls[debugStub.mock.calls.length - 1]
      expect(lastCall[1].payload).toEqual({
        data: '[filtered]',
        type: 'Buffer',
      })
    })

    describe.only('Debug logging', () => {
      let initialValue

      beforeAll(() => {
        initialValue = process.env.DEBUG_LOG_BUFFERS
      })

      afterAll(() => {
        process.env['DEBUG_LOG_BUFFERS'] = initialValue
      })

      test('logs the full payload in case of non-retriable error when "DEBUG_LOG_BUFFERS" runtime flag is set', async () => {
        process.env['DEBUG_LOG_BUFFERS'] = '1'
        const connection = new Connection(connectionOpts())
        const debugStub = jest.fn()
        connection.logger.debug = debugStub
        const protocol = apiVersions()
        protocol.response.parse = () => {
          throw new Error('non-retriable')
        }
        await connection.connect()
        await expect(connection.send(protocol)).rejects.toBeTruthy()

        const lastCall = debugStub.mock.calls[debugStub.mock.calls.length - 1]
        expect(lastCall[1].payload).toEqual(expect.any(Buffer))
      })

      test('filters payload in case of non-retriable error when "DEBUG_LOG_BUFFERS" runtime flag is not set', async () => {
        delete process.env['DEBUG_LOG_BUFFERS']
        const connection = new Connection(connectionOpts())
        const debugStub = jest.fn()
        connection.logger.debug = debugStub
        const protocol = apiVersions()
        protocol.response.parse = () => {
          throw new Error('non-retriable')
        }
        await connection.connect()
        await expect(connection.send(protocol)).rejects.toBeTruthy()

        const lastCall = debugStub.mock.calls[debugStub.mock.calls.length - 1]
        expect(lastCall[1].payload).toEqual({
          type: 'Buffer',
          data: '[filtered]',
        })
      })
    })
  })

  describe('#nextCorrelationId', () => {
    beforeEach(() => {
      connection = new Connection(connectionOpts())
    })

    test('increments the current correlationId', () => {
      const id1 = connection.nextCorrelationId()
      const id2 = connection.nextCorrelationId()
      expect(id1).toEqual(0)
      expect(id2).toEqual(1)
      expect(connection.correlationId).toEqual(2)
    })

    test('resets to 0 when correlationId is equal to Number.MAX_VALUE', () => {
      expect(connection.correlationId).toEqual(0)

      connection.nextCorrelationId()
      connection.nextCorrelationId()
      expect(connection.correlationId).toEqual(2)

      connection.correlationId = Number.MAX_VALUE
      const id1 = connection.nextCorrelationId()
      expect(id1).toEqual(0)
      expect(connection.correlationId).toEqual(1)
    })
  })

  describe('#processData', () => {
    beforeEach(() => {
      connection = new Connection(connectionOpts())
    })

    test('buffer data while it is not complete', () => {
      const correlationId = 1
      const resolve = jest.fn()
      const entry = { resolve }
      connection.pendingQueue[correlationId] = entry

      const payload = Buffer.from('ab')
      const size = Buffer.byteLength(payload) + Decoder.int32Size()
      // expected response size
      const sizePart1 = Buffer.from([0, 0])
      const sizePart2 = Buffer.from([0, 6])

      const correlationIdPart1 = Buffer.from([0, 0])
      const correlationIdPart2 = Buffer.from([0])
      const correlationIdPart3 = Buffer.from([1])

      // write half of the expected size and expect to keep buffering
      expect(connection.processData(sizePart1)).toBeUndefined()
      expect(resolve).not.toHaveBeenCalled()

      // Write the rest of the size, but without any response
      expect(connection.processData(sizePart2)).toBeUndefined()
      expect(resolve).not.toHaveBeenCalled()

      // Response consists of correlation id + payload
      // Writing 1/3 of the correlation id
      expect(connection.processData(correlationIdPart1)).toBeUndefined()
      expect(resolve).not.toHaveBeenCalled()

      // At this point, we will write N bytes, where N == size,
      // but we should keep buffering because the size field should
      // not be considered as part of the response payload
      expect(connection.processData(correlationIdPart2)).toBeUndefined()
      expect(resolve).not.toHaveBeenCalled()

      // write full payload size
      const buffer = Buffer.concat([correlationIdPart3, payload])
      connection.processData(buffer)

      expect(resolve).toHaveBeenCalledWith({
        correlationId,
        size,
        entry,
        payload,
      })
    })
  })
})
