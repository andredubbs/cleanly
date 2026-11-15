import os from 'os';
import { home } from './host';
export * from 'os';
export const homedir = () => home;
export default { ...os, homedir };
