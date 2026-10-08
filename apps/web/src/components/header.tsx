export default function Header() {
  return (
    <header class="border-b border-amber-200">
      <div class="mx-auto flex max-w-5xl items-center px-4 py-3 sm:px-6 lg:px-8">
        <a
          href="/"
          class="font-semibold tracking-wide text-stone-900 hover:text-orange-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-orange-800"
          aria-label="石窯ドーム レシピ検索"
        >
          石窯ドーム レシピ検索
        </a>
      </div>
    </header>
  );
}
