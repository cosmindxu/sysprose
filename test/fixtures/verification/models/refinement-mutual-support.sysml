package RefinementMutualSupport {

    doc /* The soundness case, and the reason `nf(C) = ¬A ∨ G` is used
         * throughout: A₁ = G₂ = p and A₂ = G₁ = p, against a system contract
         * ⟨true, p⟩.
         *
         * The bare-guarantee obligation is `G₁ ∧ G₂ ⊨ G`, which here is
         * `p ∧ p ⊨ p` — provable by inspection. The normal-form obligation is
         * `nf(C₁) ∧ nf(C₂) ∧ γ ⊨ nf(C)`, and `nf(C₁) = ¬p ∨ p = ⊤`, so it is
         * `⊤ ⊨ p`, which is false: an implementation with `p` false satisfies
         * each component contract and breaks the system guarantee. `cimatti-2015`
         * reduces to normal form precisely to close this hole.
         *
         * The `bind` is what makes the two signals ONE quantity, so alpha's
         * assumption really is beta's guarantee. The values satisfy everything
         * the file states; a refinement obligation does not read them, which is
         * the whole difference between "holds of this design" and "holds of
         * every implementation the contracts admit". */

    part def Alpha {
        attribute signal : Real = 2.0;
    }

    part def Beta {
        attribute signal : Real = 2.0;
    }

    part def Loop {
        part alpha : Alpha;
        part beta : Beta;
        bind Alpha::signal = Beta::signal;
    }

    requirement def SystemHolds {
        attribute id = "R-MS-000";
        subject sys : Loop;
        require constraint { sys.alpha.signal >= 1.0 }
    }

    requirement def AlphaContract {
        attribute id = "R-MS-001";
        subject a : Alpha;
        assume constraint { a.signal >= 1.0 }
        require constraint { a.signal >= 1.0 }
    }

    requirement def BetaContract {
        attribute id = "R-MS-002";
        subject b : Beta;
        assume constraint { b.signal >= 1.0 }
        require constraint { b.signal >= 1.0 }
    }

    satisfy SystemHolds by Loop;
    satisfy AlphaContract by Loop::alpha;
    satisfy BetaContract by Loop::beta;
}
