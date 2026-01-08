import "./globals.css";

export const metadata = {
  title: "Class Notes Transcriber",
  description: "Realtime voice transcription with class/date tabs and local save.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
