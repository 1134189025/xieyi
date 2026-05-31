import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import toast from 'react-hot-toast';

interface QrCodeDisplayProps {
  pixCode: string | null;
  pixQrPngBase64: string | null;
  pixImageUrl?: string | null;
  pixExpiresAt?: string | null;
}

export default function QrCodeDisplay({ pixCode, pixQrPngBase64, pixImageUrl, pixExpiresAt }: QrCodeDisplayProps) {
  const [copied, setCopied] = useState(false);

  if (!pixCode) {
    return <p className="text-gray-500 text-center">暂无 Pix 付款码</p>;
  }

  const imageSrc = pixQrPngBase64
    ? `data:image/png;base64,${pixQrPngBase64}`
    : pixImageUrl ?? undefined;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(pixCode);
      setCopied(true);
      toast.success('Pix 付款码已复制');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('复制失败，请手动复制');
    }
  };

  return (
    <div className="flex flex-col items-center gap-4">
      {imageSrc && (
        <img src={imageSrc} alt="Pix 二维码" className="w-64 h-64 border rounded-lg" />
      )}

      <div className="w-full max-w-md">
        <label className="block text-sm font-medium text-gray-700 mb-1">Pix 付款码</label>
        <div className="flex gap-2">
          <input
            type="text"
            readOnly
            value={pixCode}
            className="flex-1 text-xs px-3 py-2 border rounded-lg bg-gray-50 font-mono"
            onClick={(e) => (e.target as HTMLInputElement).select()}
          />
          <button
            onClick={handleCopy}
            className="px-3 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
        </div>
      </div>

      {pixExpiresAt && (
        <p className="text-sm text-gray-500">
          过期时间：{new Date(pixExpiresAt).toLocaleString('zh-CN')}
        </p>
      )}
    </div>
  );
}
