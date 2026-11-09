import { Newsreader } from "next/font/google";

const display = Newsreader({ subsets: ["latin"] });

export default function Page() {
  return (
    <a className={`rounded-lg text-[#3f5d3a] ${display.className}`} href="#add">
      Read
    </a>
  );
}
