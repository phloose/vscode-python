let logging = false;

export function startLogging() { logging = true; }

export function log(message: string, ...args: any[]) {
	if (logging) {
		console.log(message, ...args);
	}
}