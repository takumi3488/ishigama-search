import { Title } from "@solidjs/meta";
import { Loading } from "solid-js";

import Header from "~/components/header";
import Loader from "~/components/loader";
import { Router } from "~/router";

import "./styles.css";

export default function App() {
  return (
    <Router>
      {(props) => (
        <>
          <Title>石窯ドーム レシピ検索 | 東芝ライフスタイル</Title>
          <div class="grid h-svh grid-rows-[auto_1fr]">
            <Header />
            <Loading fallback={<Loader />}>{props.children}</Loading>
          </div>
        </>
      )}
    </Router>
  );
}
