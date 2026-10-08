# Engineering posture

This repository is a work in progress. There is _no_ backwards compatibility
requirement.

- **Think first:** Verify behavior against the upstream sources. State
  consequential assumptions and ask when interpretation changes the task. Work
  backwards from the user when designing the solution.
- **Keep it simple:** Implement only what is needed. Avoid speculative features,
  premature optimization, and clever control flow. Shared abstractions are only
  acceptable when multiple consumers/implementations exist.
- **Stay strict:** Write idiomatic, strictly typed code. Do not suppress check
  failures without precise justification and user approval. Assert aggressively.
- **Be surgical:** Touch only relevant code, match existing style, remove what
  your change makes obsolete, and report unrelated issues instead of widening
  scope.
- **Verify outcomes:** Run relevant tests and static checks. Measure before and
  after performance work.
- **Make Ken Thompson proud:** Follow the "Unix Philosophy".

## Unix Philosophy [^1]

The "Unix philosophy" originated with Ken Thompson's early meditations on how to
design a small but capable operating system with a clean service interface. It
grew as the Unix culture learned things about how to get maximum leverage out of
Thompson's design. It absorbed lessons from many sources along the way.

The Unix philosophy is not a formal design method. It wasn't handed down from
the high fastnesses of theoretical computer science as a way to produce
theoretically perfect software. Nor is it that perennial executive's mirage,
some way to magically extract innovative but reliable software on too short a
deadline from unmotivated, badly managed, and underpaid programmers.

The Unix philosophy (like successful folk traditions in other engineering
disciplines) is bottom-up, not top-down. It is pragmatic and grounded in
experience. It is not to be found in official methods and standards, but rather
in the implicit half-reflexive knowledge, the expertise that the Unix culture
transmits. It encourages a sense of proportion and skepticism — and shows both
by having a sense of (often subversive) humor.

Doug McIlroy, the inventor of Unix pipes and one of the founders of the Unix
tradition, had this to say at the time [^2]:

> 1. Make each program do one thing well. To do a new job, build afresh rather
>    than complicate old programs by adding new features.
> 2. Expect the output of every program to become the input to another, as yet
>    unknown, program. Don't clutter output with extraneous information. Avoid
>    stringently columnar or binary input formats. Don't insist on interactive
>    input.
> 3. Design and build software, even operating systems, to be tried early,
>    ideally within weeks. Don't hesitate to throw away the clumsy parts and
>    rebuild them.
> 4. Use tools in preference to unskilled help to lighten a programming task,
>    even if you have to detour to build the tools and expect to throw some of
>    them out after you've finished using them.

He later summarized it this way (quoted in A Quarter Century of Unix [^3]):

> This is the Unix philosophy: Write programs that do one thing and do it well.
> Write programs to work together. Write programs to handle text streams,
> because that is a universal interface.

Rob Pike, who became one of the great masters of C, offers a slightly different
angle in Notes on C Programming [^4]:

> Rule 1. You can't tell where a program is going to spend its time. Bottlenecks
> occur in surprising places, so don't try to second guess and put in a speed
> hack until you've proven that's where the bottleneck is.
>
> Rule 2. Measure. Don't tune for speed until you've measured, and even then
> don't unless one part of the code overwhelms the rest.
>
> Rule 3. Fancy algorithms are slow when n is small, and n is usually small.
> Fancy algorithms have big constants. Until you know that n is frequently going
> to be big, don't get fancy. (Even if n does get big, use Rule 2 first.)
>
> Rule 4. Fancy algorithms are buggier than simple ones, and they're much harder
> to implement. Use simple algorithms as well as simple data structures.
>
> Rule 5. Data dominates. If you've chosen the right data structures and
> organized things well, the algorithms will almost always be self-evident. Data
> structures, not algorithms, are central to programming.[^5]
>
> Rule 6. There is no Rule 6.

Ken Thompson, the man who designed and implemented the first Unix, reinforced
Pike's rule 4 with a gnomic maxim worthy of a Zen patriarch:

> When in doubt, use brute force.

More of the Unix philosophy was implied not by what these elders said but by
what they did and the example Unix itself set. Looking at the whole, we can
abstract the following ideas:

1. Rule of Modularity: Write simple parts connected by clean interfaces.
2. Rule of Clarity: Clarity is better than cleverness.
3. Rule of Composition: Design programs to be connected to other programs.
4. Rule of Separation: Separate policy from mechanism; separate interfaces from
   engines.
5. Rule of Simplicity: Design for simplicity; add complexity only where you
   must.
6. Rule of Parsimony: Write a big program only when it is clear by demonstration
   that nothing else will do.
7. Rule of Transparency: Design for visibility to make inspection and
   debuggingeasier.
8. Rule of Robustness: Robustness is the child of transparency and simplicity.
9. Rule of Representation: Fold knowledge into data so program logic can be
   stupid and robust.
10. Rule of Least Surprise: In interface design, always do the least surprising
    thing.
11. Rule of Silence: When a program has nothing surprising to say, it should say
    nothing.
12. Rule of Repair: When you must fail, fail noisily and as soon as possible.
13. Rule of Economy: Programmer time is expensive; conserve it in preference to
    machine time.
14. Rule of Generation: Avoid hand-hacking; write programs to write programs
    when you can.
15. Rule of Optimization: Prototype before polishing. Get it working before you
    optimize it.
16. Rule of Diversity: Distrust all claims for "one true way".
17. Rule of Extensibility: Design for the future, because it will be here sooner
    than you think.

[^1]: Copied from <https://cscie2x.dce.harvard.edu/hw/ch01s06.html>

[^2]:
    The Bell System Technical Journal. Bell Laboratories. M. D. McIlroy, E. N.
    Pinson, and B. A. Tague. “Unix Time-Sharing System Forward”. 1978. 57 (6,
    part 2). p. 1902.

[^3]:
    Salus, Peter H.; A Quarter-Century Of Unix, from Addison Wesley 1994,
    ISBN 0201547775.

[^4]:
    Pike, Rob; Notes on Programming In C; 1989. This document is popular on the
    Web; a title search is sure to find several copies. One is at
    <https://www.lysator.liu.se/c/pikestyle.html>

[^5]:
    "Show me your flow charts and conceal your tables and I shall continue to be
    mystified, show me your tables and I won't usually need your flow charts;
    they'll be obvious"
