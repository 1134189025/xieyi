import { randomInt, randomUUID } from 'node:crypto';

export interface BrazilBillingAddress {
  country: 'BR';
  line1: string;
  city: string;
  state: string;
  postalCode: string;
}

export interface BrazilBillingProfile {
  name: string;
  email: string;
  cpf: string;
  address: BrazilBillingAddress;
}

const FIRST_NAMES = [
  'Rui',
  'Lucas',
  'Mateus',
  'Gabriel',
  'Ana',
  'Mariana',
  'Carla',
  'Paula',
] as const;

const LAST_NAMES = [
  'Silva',
  'Santos',
  'Oliveira',
  'Souza',
  'Pereira',
  'Costa',
  'Rodrigues',
  'Almeida',
] as const;

const CITY_ADDRESSES = [
  { city: 'Porto Alegre', state: 'RS', postalCode: '90000-000' },
  { city: 'Curitiba', state: 'PR', postalCode: '80000-000' },
  { city: 'Sao Paulo', state: 'SP', postalCode: '01000-000' },
  { city: 'Rio de Janeiro', state: 'RJ', postalCode: '20000-000' },
  { city: 'Belo Horizonte', state: 'MG', postalCode: '30000-000' },
  { city: 'Salvador', state: 'BA', postalCode: '40000-000' },
] as const;

const STREET_NAMES = [
  'Harbor Road',
  'Rua das Flores',
  'Avenida Central',
  'Rua Amazonas',
  'Rua Sao Bento',
  'Avenida Atlantica',
] as const;

const STATE_NAME_TO_CODE = new Map<string, string>([
  ['acre', 'AC'],
  ['alagoas', 'AL'],
  ['amapa', 'AP'],
  ['amazonas', 'AM'],
  ['bahia', 'BA'],
  ['ceara', 'CE'],
  ['distrito federal', 'DF'],
  ['espirito santo', 'ES'],
  ['goias', 'GO'],
  ['maranhao', 'MA'],
  ['mato grosso', 'MT'],
  ['mato grosso do sul', 'MS'],
  ['minas gerais', 'MG'],
  ['para', 'PA'],
  ['paraiba', 'PB'],
  ['parana', 'PR'],
  ['pernambuco', 'PE'],
  ['piaui', 'PI'],
  ['rio de janeiro', 'RJ'],
  ['rio grande do norte', 'RN'],
  ['rio grande do sul', 'RS'],
  ['rondonia', 'RO'],
  ['roraima', 'RR'],
  ['santa catarina', 'SC'],
  ['sao paulo', 'SP'],
  ['sergipe', 'SE'],
  ['tocantins', 'TO'],
]);

export function generateBrazilBillingProfile(): BrazilBillingProfile {
  const firstName = pick(FIRST_NAMES);
  const lastName = pick(LAST_NAMES);
  const cityAddress = pick(CITY_ADDRESSES);
  const streetNumber = randomInt(10, 999);
  const streetName = pick(STREET_NAMES);
  const mailbox = randomUUID().replaceAll('-', '').slice(0, 12);

  return {
    name: `${firstName} ${lastName}`,
    email: `pix.${mailbox}@example.com`,
    cpf: generateCpf(),
    address: {
      country: 'BR',
      line1: `${streetNumber} ${streetName}`,
      city: cityAddress.city,
      state: cityAddress.state,
      postalCode: cityAddress.postalCode,
    },
  };
}

export function generateCpf(): string {
  const digits = Array.from({ length: 9 }, () => randomInt(0, 10));
  digits.push(calculateCpfCheckDigit(digits, 10));
  digits.push(calculateCpfCheckDigit(digits, 11));
  return formatCpfDigits(digits);
}

export function validateCpf(cpf: string): boolean {
  const digits = cpfDigits(cpf);
  if (digits.length !== 11) return false;
  if (digits.every((digit) => digit === digits[0])) return false;

  const firstCheckDigit = calculateCpfCheckDigit(digits.slice(0, 9), 10);
  const secondCheckDigit = calculateCpfCheckDigit(digits.slice(0, 10), 11);
  return digits[9] === firstCheckDigit && digits[10] === secondCheckDigit;
}

export function normalizeBrazilState(state: string): string {
  const trimmed = state.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();

  const normalized = removeDiacritics(trimmed).toLowerCase();
  const code = STATE_NAME_TO_CODE.get(normalized);
  if (!code) throw new Error(`Unsupported Brazil state: ${state}`);
  return code;
}

function calculateCpfCheckDigit(digits: number[], weightStart: number): number {
  const sum = digits.reduce((total, digit, index) => total + digit * (weightStart - index), 0);
  const remainder = (sum * 10) % 11;
  return remainder === 10 ? 0 : remainder;
}

function cpfDigits(cpf: string): number[] {
  return cpf.replace(/\D/g, '').split('').map((digit) => Number(digit));
}

function formatCpfDigits(digits: number[]): string {
  const value = digits.join('');
  return `${value.slice(0, 3)}.${value.slice(3, 6)}.${value.slice(6, 9)}-${value.slice(9, 11)}`;
}

function pick<T>(items: readonly T[]): T {
  return items[randomInt(0, items.length)];
}

function removeDiacritics(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
