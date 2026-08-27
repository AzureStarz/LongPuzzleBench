/** Minimal Node test loader for Cocos-style extensionless TypeScript imports. */
export async function resolve(specifier, context, nextResolve) {
    try {
        return await nextResolve(specifier, context);
    } catch (error) {
        if ((specifier.startsWith('./') || specifier.startsWith('../')) && !specifier.match(/\.[a-z]+$/i)) {
            return nextResolve(`${specifier}.ts`, context);
        }
        throw error;
    }
}
