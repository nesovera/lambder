/**
 * The key of the door the mock's own adapters open on a LambderMockApp: what
 * an adapter asks of the runtime and tells it beyond handing it a call.
 *
 * A symbol rather than named members, and exported by no entry point: the
 * package's exports map is what a consumer can import, so only an adapter of
 * the package's own (the MSW handler) can name the key, and nothing on the
 * app's typed surface offers an app the adapter's bookkeeping as an API.
 */
export const LAMBDER_MOCK_ADAPTER_DOOR = Symbol("lambder.mockAdapterDoor");
