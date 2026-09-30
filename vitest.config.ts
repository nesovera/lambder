import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // The call summary lines instances built with the defaults write,
        // kept out of the suite's output; see the file.
        setupFiles: ['tests/callSummaryFilter.setup.ts'],
    },
});
