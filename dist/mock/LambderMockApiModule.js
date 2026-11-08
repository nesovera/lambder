/**
 * A part of a mock app with mock guards of its own: the app's entry builders,
 * typed with the module's guards beside the app's. Made by the mock app's
 * defineApiModule(); its entries are registered as any are (register,
 * registerPartial), and registering them adds the module's guards to the
 * app, refusing a name the app or another module declares. The mock twin of
 * the server's LambderApiModule, so a module's mock guards are declared with
 * the module's mocks, and the app's own setup imports none of them.
 *
 * `G` is the app's guards and the module's together, which is what the
 * entries' handlers read guardData by.
 */
export class LambderMockApiModule {
    door;
    constructor(door) {
        this.door = door;
    }
    /** A mock for one of the module's endpoints, as the app's api() builds one: its guards may be the app's and the module's own. */
    api(name, entry) {
        return this.door.api(name, entry);
    }
    /** One of the module's endpoints deliberately left without a mock, as the app's notMocked() builds one; its restated guards may name the module's. */
    notMocked(name, input) {
        return this.door.notMocked(name, input);
    }
    /** The entries of one slice, keyed by name, as the app's apiSlice() gathers them. */
    apiSlice(...entries) {
        return this.door.apiSlice(...entries);
    }
    /** Replaces one of the module's registered handlers until restored, as the app's override() does, its guardData typed with the module's guards. */
    override(name, handler) {
        return this.door.override(name, handler);
    }
}
